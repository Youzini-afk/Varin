/** Call-scoped adapter to real native Run primitives. No extension input can supply
 * a Run, epoch, executor identity or resource grant. Rust remains the receipt owner. */
import { parseVarinToolJson, VARIN_AGENT_DRIVER_CAPABILITY } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import type { KernelClient } from './kernel-client.js';
import type { DriverModelInput, DriverToolInput, DriverCheckpointInput, DriverDeliveryInput, DriverReceiptInput, DriverContextInput, DriverCancelInput, DriverWaitInput, DriverFinishInput } from './protocol.generated.js';
import { runDriverCall } from './run-driver-invocation.js';
export { VARIN_AGENT_DRIVER_CAPABILITY };

export function createRunDriverOwner(kernel: KernelClient): HostCapabilityHandler {
  return (method, params, context) => runDriverCall(context, async authority => {
    if (kernel.kernelEpoch !== authority.kernelEpoch) throw new Error('run_driver_epoch_changed');
    const instanceId = authority.instanceId;
    // Keep the complete JSON for the canonical native decoder. In particular, do not
    // discard extension-supplied extra authority fields and accidentally accept them.
    const input = parseVarinToolJson(params);
    // No observer AbortSignal races these RPCs. Native cancellation reaches the Run's
    // actual primitive tokens, and both owners retain already accepted work to drain.
    switch (method) {
      case 'model': return parseVarinToolJson(await kernel.agentRuntimeRequest('runtime.driver.model', { instanceId, input: input as unknown as DriverModelInput }));
      case 'tool': return parseVarinToolJson(await kernel.agentRuntimeRequest('runtime.driver.tool', { instanceId, input: input as unknown as DriverToolInput }));
      case 'checkpoint': return parseVarinToolJson(await kernel.agentRuntimeRequest('runtime.driver.checkpoint', { instanceId, input: input as unknown as DriverCheckpointInput }));
      case 'deliver': return parseVarinToolJson(await kernel.agentRuntimeRequest('runtime.driver.deliver', { instanceId, input: input as unknown as DriverDeliveryInput }));
      case 'wait': return parseVarinToolJson(await kernel.agentRuntimeRequest('runtime.driver.wait', { instanceId, input: input as unknown as DriverWaitInput }));
      case 'context': return parseVarinToolJson(await kernel.agentRuntimeRequest('runtime.driver.context', { instanceId, input: input as unknown as DriverContextInput }));
      case 'cancel': return parseVarinToolJson(await kernel.agentRuntimeRequest('runtime.driver.cancel', { instanceId, input: input as unknown as DriverCancelInput }));
      case 'finish': return parseVarinToolJson(await kernel.agentRuntimeRequest('runtime.driver.finish', { instanceId, input: input as unknown as DriverFinishInput }));
      case 'receipt': return parseVarinToolJson(await kernel.agentRuntimeRequest('runtime.driver.receipt', { instanceId, input: input as unknown as DriverReceiptInput }));
      default: throw new Error('run_driver_method_invalid');
    }
  });
}
