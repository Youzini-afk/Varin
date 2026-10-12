/** Ordinary capability adapter. The original live invocation and Kernel own all authority. */
import { parseVarinToolJson, VARIN_RUNTIME_TOOLS_CAPABILITY, type NestedToolInput, type NestedToolReceipt } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import type { KernelClient } from './kernel-client.js';
import { runNestedToolCall, emitToolOutput } from './tool-invocation.js';
export { VARIN_RUNTIME_TOOLS_CAPABILITY };
export function createNestedToolOwner(kernel: KernelClient): HostCapabilityHandler {
  return async (method, params, context) => {
    if (method === 'output') { emitToolOutput(context, params); return null; }
    if (method === 'list' || method === 'describe') {
      if (!params || typeof params !== 'object' || Array.isArray(params)
        || Object.keys(params).some(key => method === 'list' || key !== 'name')
        || (method === 'describe' && (typeof params.name !== 'string' || !params.name.trim()))) {
        throw new Error('nested_tool_inspection_invalid');
      }
      return runNestedToolCall(context, async authority => parseVarinToolJson(await kernel.agentRuntimeRequest(
        'runtime.tools.inspect', { parentOperationId: authority.operationId, executorOwner: authority.executorOwner,
          ...(method === 'describe' ? { name: params.name as string } : {}) }, context.signal)));
    }
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
