/** Ordinary capability adapter. The original live invocation and Kernel own all authority. */
import { parseVarinToolJson, VARIN_RUNTIME_TOOLS_CAPABILITY, type NestedToolInput, type NestedToolReceipt } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import type { KernelClient } from './kernel-client.js';
import { runNestedToolCall } from './tool-invocation.js';
export { VARIN_RUNTIME_TOOLS_CAPABILITY };
export function createNestedToolOwner(kernel: KernelClient): HostCapabilityHandler {
  return async (method, params, context) => {
    if (method !== 'invoke') throw new Error('nested_tool_method_invalid');
    return runNestedToolCall(context, async authority => {
      // Do not race this execution receipt with the broker observer's AbortSignal. Runtime
      // cancellation reaches the original registered child token; both scopes drain this RPC.
      const receipt = await kernel.agentRuntimeRequest<NestedToolReceipt, 'runtime.tools.invoke'>('runtime.tools.invoke', {
        parentOperationId: authority.operationId, executorOwner: authority.executorOwner,
        // Preserve the full JSON input. Rust owns structural decoding and rejects unknown fields.
        call: parseVarinToolJson(params) as unknown as NestedToolInput,
      });
      return parseVarinToolJson({ operationId: receipt.operationId, completion: receipt.completion });
    });
  };
}
