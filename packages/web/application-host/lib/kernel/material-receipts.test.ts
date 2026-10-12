import { expect, it, vi } from 'vitest';
import { WEB_TOOL_DECLARATIONS, VARIN_BUILTIN_WEB_EXTENSION_ID } from '@varin/extension-builtins';
import { createMaterialCollections, materialMutationOperationId } from '../harness/material-collections.js';
import { createMaterialStoreFixture } from '../harness/web-materials.test-helper.js';
import { createMaterialReceiptReconciler } from './material-receipts.js';
import { extensionToolSchema } from './extension-tool-owner.js';
import { threadMaterialScope } from './material-storage.js';
import { toolOperationId, type Operation, type ToolOrigin } from './protocol.generated.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';

async function fixture(origin: ToolOrigin = { kind: 'model_step', request_id: 'request' }) {
  const workspace = threadMaterialScope('root'), threadId = 'reader', callId = origin.kind === 'policy_action' ? origin.node_id : 'create';
  const operationId = toolOperationId(origin, callId);
  const f = createMaterialStoreFixture({ operationReceipts: true, workspaceId: workspace });
  const collections = createMaterialCollections(f.workingStates, { materials: f.materials });
  const params = { action: 'create' as const, name: 'Saved original' };
  const result = await collections.execute(params, { authority: { kind: 'thread', owningWorkspaceId: workspace, threadId }, origin: operationId });
  const declaration = WEB_TOOL_DECLARATIONS.find(value => value.id === 'varin.web.collections')!, tool = extensionToolSchema(declaration);
  const binding = { providerKey: 'accepted-provider', extensionId: VARIN_BUILTIN_WEB_EXTENSION_ID, extensionVersion: '0.1.0',
    serviceId: declaration.id, serviceVersion: declaration.version, artifactIntegrity: 'accepted-artifact', declarationHash: tool.version,
    configurationIdentity: 'accepted-configuration', tool };
  const operation = { id: operationId, run_id: 'run', effect: 'unknown', execution_owner: { kind: 'external', identity: binding.providerKey, epoch: 'old-owner' },
    intent: { origin, call: { call_id: callId, name: tool.name, schema_version: tool.version, arguments: params },
      contract: { name: tool.name, schema_version: tool.version, read_only: false, completion: 'result' } } } as Operation;
  const runtime = { threads: async () => [{ thread_id: threadId }], activeOperations: async () => [operation],
    run: async () => ({ id: 'run', thread_id: threadId, branch_id: 'branch' }),
    launch: async () => ({ run_id: 'run', selection: { extension_bindings: [binding] } }),
    familyList: async () => ({ rootThreadId: 'root', members: [{ threadId, branches: [{ branchId: 'branch' }] }] }),
  } as unknown as AgentRuntimeClient;
  let callback: boolean | undefined;
  const kernel = { toolCallbackEnded: () => callback, publishRecoveredToolReceipt: vi.fn(async () => {}) };
  const onError = vi.fn();
  const recover = createMaterialReceiptReconciler({ runtime, kernel, collections, onError });
  return { f, collections, result, operation, binding, kernel, onError, recover, callback: (value: boolean | undefined) => { callback = value; } };
}

it.each([
  { kind: 'model_step', request_id: 'request' },
  { kind: 'policy_action', action_id: 'action', node_id: 'node' },
  { kind: 'nested_call', parent_operation_id: 'parent' },
] satisfies ToolOrigin[])('rebuilds only the original storage receipt and delivery identity for $kind', async origin => {
  const f = await fixture(origin);
  const read = vi.spyOn(f.collections, 'receipt');
  f.callback(false); await f.recover(new AbortController().signal);
  expect(read).not.toHaveBeenCalled(); expect(f.kernel.publishRecoveredToolReceipt).not.toHaveBeenCalled();
  f.callback(undefined); await f.recover(new AbortController().signal);
  expect(f.onError).not.toHaveBeenCalled();
  expect(f.kernel.publishRecoveredToolReceipt).toHaveBeenCalledWith(expect.objectContaining({
    call: expect.objectContaining({ operationId: f.operation.id, origin }), executionOwner: f.operation.execution_owner,
    receipt: { executor_stopped: true, completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed', content: { data: f.result.result, parts: [] } } },
  }));
  expect(f.f.records.size).toBe(1);
});

it('does not guess effects for missing, failed-to-read or changed-provider original operations', async () => {
  const f = await fixture();
  f.binding.providerKey = 'other'; await f.recover(new AbortController().signal);
  expect(f.kernel.publishRecoveredToolReceipt).not.toHaveBeenCalled(); expect(f.onError).toHaveBeenCalledOnce();
  f.binding.providerKey = 'accepted-provider'; f.f.operations.delete(materialMutationOperationId(f.operation.id));
  f.onError.mockClear(); await f.recover(new AbortController().signal);
  expect(f.onError).not.toHaveBeenCalled(); expect(f.kernel.publishRecoveredToolReceipt).not.toHaveBeenCalled();
  vi.spyOn(f.collections, 'receipt').mockRejectedValueOnce(new Error('storage offline'));
  await f.recover(new AbortController().signal);
  expect(f.onError).toHaveBeenCalledOnce(); expect(f.kernel.publishRecoveredToolReceipt).not.toHaveBeenCalled();
});
