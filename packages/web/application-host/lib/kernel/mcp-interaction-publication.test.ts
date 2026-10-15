import { expect, it, vi } from 'vitest';
import { publishMcpInteractionRequest } from './mcp-interaction-publication.js';
import type { KernelClient } from './kernel-client.js';
import type { McpInteractionOpenParams, McpInteractionRecord } from './protocol.generated.js';
const input: McpInteractionOpenParams = {
  id: 'original', mode: 'form', binding: { operationId: 'operation', executionOwner: { kind: 'external', identity: 'tool', epoch: 'epoch' },
    endpoint: { server: 'server', configurationVersion: 'config', credentialVersion: 'credential', resourceKey: 'source-resource' },
    connectionId: 'original-connection', source: { kind: 'server_request', requestId: 3,
      relation: { kind: 'rpc_response_stream', outgoingRequestId: 2 } } },
  request: { message: 'Original request', requestedSchema: { type: 'object', properties: {} } },
  presentation: { mode: 'form', message: 'Original request', fields: [] },
};
const record = { id: input.id, binding: input.binding, availability: 'owner_unavailable', choice: null } as McpInteractionRecord;
it('retries only immutable publication after transient storage failure and recalls a lost committed ACK', async () => {
  const bodies: unknown[] = []; const delays: number[] = []; let stored = false;
  const request = vi.fn(async (method: string, params: unknown) => {
    if (method.endsWith('.open')) {
      bodies.push(structuredClone(params));
      if (bodies.length === 1) throw Object.assign(new Error('Storage unavailable'), { code: 'storage-error' });
      stored = true; throw new Error('Committed, response lost');
    }
    if (!stored) throw new Error('Not yet readable');
    return { record, request: input.request, presentation: input.presentation };
  });
  const result = await publishMcpInteractionRequest(input, { kernel: { agentRuntimeRequest: request } as unknown as KernelClient,
    disposed: () => false, waitRetry: async delay => { delays.push(delay); }, report: () => {} });
  expect(result).toEqual(record); expect(bodies).toEqual([input, input]); expect(delays).toEqual([250]);
  expect(request.mock.calls.map(([method]) => method)).toEqual(['runtime.mcp.interaction.open', 'runtime.mcp.interaction.read',
    'runtime.mcp.interaction.open', 'runtime.mcp.interaction.read']);
});
it('does not retry definite private rejection or adopt changed presentation bytes', async () => {
  for (const changed of [false, true]) {
    const waitRetry = vi.fn(async () => {});
    const request = vi.fn(async (method: string) => {
      if (method.endsWith('.open')) throw Object.assign(new Error('Rejected'), { code: changed ? 'storage-error' : 'operation-error' });
      if (!changed) throw new Error('Absent');
      return { record, request: input.request, presentation: { ...input.presentation, message: 'Changed' } };
    });
    await expect(publishMcpInteractionRequest(input, { kernel: { agentRuntimeRequest: request } as unknown as KernelClient,
      disposed: () => false, waitRetry, report: () => {} })).rejects.toMatchObject({ code: changed ? 'mcp_interaction_conflict' : 'operation-error' });
    expect(waitRetry).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(2);
  }
});
it('ends the original publication retry at owner disposal without treating absence as success', async () => {
  let disposed = false;
  const request = vi.fn(async () => { throw new Error('Unavailable'); });
  await expect(publishMcpInteractionRequest(input, { kernel: { agentRuntimeRequest: request } as unknown as KernelClient,
    disposed: () => disposed, waitRetry: async () => { disposed = true; }, report: () => {} }))
    .rejects.toMatchObject({ code: 'mcp_interaction_owner_unavailable' });
  expect(request).toHaveBeenCalledTimes(2);
});
