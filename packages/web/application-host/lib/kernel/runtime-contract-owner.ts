import {
  parseVarinRuntimeContractRequest, parseVarinToolJson, VARIN_RUNTIME_CONTRACTS_CAPABILITY,
} from '@varin/extension-contract';
import type { ApplicationExtensionRuntime, HostCapabilityHandler } from '@varin/extension-host';
import type { KernelClient } from './kernel-client.js';
import type { RunContextScope } from './protocol.generated.js';
import { requireToolInvocation, runNestedToolCall } from './tool-invocation.js';

export { VARIN_RUNTIME_CONTRACTS_CAPABILITY };
/** Current metadata and explicit immutable source reads retain this invocation's original authority. */
export function createRuntimeContractOwner(options: {
  extensions: ApplicationExtensionRuntime;
  kernel: KernelClient;
}): HostCapabilityHandler {
  return (method, params, context) => {
    if (method !== 'query') throw new Error('runtime_contract_method_invalid');
    const request = parseVarinRuntimeContractRequest(params);
    return runNestedToolCall(context, async authority => {
      const admitted = await options.kernel.agentRuntimeRequest<RunContextScope | null, 'runtime.run.scope'>(
        'runtime.run.scope', { runId: authority.runId }, context.signal);
      requireToolInvocation(context);
      const result = await options.extensions.queryContracts(request, { routing: {
        threadId: authority.threadId, sourceRunId: authority.runId, ...(admitted?.projectId ? { projectId: admitted.projectId } : {}),
      } }, context.signal);
      requireToolInvocation(context);
      return parseVarinToolJson(result);
    });
  };
}
