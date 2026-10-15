/** Recovery reads the original Storage operation; it never invokes a tool or fetches a URL. */
import { WEB_TOOL_DECLARATIONS, VARIN_BUILTIN_WEB_EXTENSION_ID } from '@varin/extension-builtins';
import { parseVarinToolJson } from '@varin/extension-contract';
import type { MaterialsCollectionParams } from '@varin/protocol';
import { MaterialCollectionMutationError, type createMaterialCollections } from '../harness/material-collections.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import { threadMaterialScope } from './material-storage.js';
import { toolOperationId, validToolOrigin } from './protocol.generated.js';
import type { HostToolCall, ToolExecutionReceipt } from './tool-bridge.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const declaration = WEB_TOOL_DECLARATIONS.find(value => value.id === 'varin.web.collections')!;
export function createMaterialReceiptReconciler(options: {
  runtime: Pick<AgentRuntimeClient, 'threads' | 'activeOperations' | 'run' | 'launch' | 'familyList'>;
  kernel: Pick<KernelClient, 'toolCallbackEnded' | 'publishRecoveredToolReceipt'>;
  collections: ReturnType<typeof createMaterialCollections>;
  onError(operationId: string | undefined, error: unknown): void;
}): (signal: AbortSignal) => Promise<void> {
  return async signal => {
    for (const thread of await options.runtime.threads(signal)) {
      for (const operation of await options.runtime.activeOperations(thread.thread_id, undefined, signal)) {
        const intent = operation.intent;
        if (operation.effect !== 'unknown' || operation.execution_owner?.kind !== 'external'
          || !object(intent) || !object(intent.call) || intent.call.name !== declaration.tool!.name) continue;
        try {
          signal.throwIfAborted();
          const executionOwner = operation.execution_owner, originalCall = intent.call;
          if (options.kernel.toolCallbackEnded(operation.run_id, operation.execution_owner, operation.id) === false) continue;
          const [run, launch] = await Promise.all([options.runtime.run(operation.run_id, signal), options.runtime.launch(operation.run_id, signal)]);
          const binding = launch?.selection.extension_bindings.find(value => value.serviceId === declaration.id
            && value.serviceVersion === declaration.version && value.extensionId === VARIN_BUILTIN_WEB_EXTENSION_ID
            && value.providerKey === executionOwner.identity
            && value.tool.name === originalCall.name && value.tool.version === originalCall.schema_version
            && value.declarationHash === value.tool.version && value.artifactIntegrity.length > 0);
          const origin = intent.origin;
          if (!binding || !object(binding.tool.metadata) || binding.tool.metadata.service_id !== binding.serviceId
            || binding.tool.metadata.operation !== 'effect' || run.thread_id !== thread.thread_id || launch?.run_id !== run.id
            || !object(intent.contract) || intent.contract.name !== originalCall.name
            || intent.contract.schema_version !== originalCall.schema_version || intent.contract.read_only !== false
            || intent.contract.completion !== 'result'
            || typeof intent.call.call_id !== 'string' || typeof intent.call.schema_version !== 'string'
            || !validToolOrigin(origin) || toolOperationId(origin, intent.call.call_id) !== operation.id
            || !object(intent.call.arguments)) throw new Error('Original material invocation or builtin binding is unavailable');
          const params = intent.call.arguments as unknown as MaterialsCollectionParams;
          if (params.action === 'list' || params.action === 'search') continue;
          const family = await options.runtime.familyList({ callerThreadId: run.thread_id, includeSelf: true }, signal);
          if (!family.members.some(member => member.threadId === run.thread_id && member.branches.some(branch => branch.branchId === run.branch_id))) {
            throw new Error('Original material Thread and branch are unavailable');
          }
          const call: HostToolCall = { runId: run.id, operationId: operation.id, origin, callId: intent.call.call_id,
            name: binding.tool.name, schemaVersion: binding.tool.version, arguments: parseVarinToolJson(params) };
          let receipt: ToolExecutionReceipt;
          try {
            const saved = await options.collections.receipt(params, { origin: operation.id,
              authority: { kind: 'thread', threadId: run.thread_id, owningWorkspaceId: threadMaterialScope(family.rootThreadId) } });
            // Missing is not evidence of a stopped or undispatched invocation.
            if (!saved) continue;
            receipt = { executor_stopped: true, completion: { kind: 'result', outcome: 'succeeded', effect: saved.effect,
              content: { data: parseVarinToolJson(saved.result), parts: [] } } };
          } catch (error) {
            if (!(error instanceof MaterialCollectionMutationError) || error.effect !== 'none') throw error;
            receipt = { executor_stopped: true, completion: { kind: 'result', outcome: 'failed', effect: 'none',
              content: { data: { status: 'failed', error: error.message }, parts: [] } } };
          }
          signal.throwIfAborted();
          // A callback may have become observable while reading the durable receipt.
          if (options.kernel.toolCallbackEnded(run.id, operation.execution_owner, operation.id) === false) continue;
          await options.kernel.publishRecoveredToolReceipt({ call, executionOwner: operation.execution_owner, receipt });
        } catch (error) { if (!signal.aborted) options.onError(operation.id, error); }
      }
    }
  };
}
