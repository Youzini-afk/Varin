import type { KernelClient } from '../kernel/kernel-client.js';
import { KernelClientError } from '../kernel/kernel-error.js';

/** The same native counter used by conversation compaction, held for one consumer. */
export async function acquireTokenCounter(
  kernel: Pick<KernelClient, 'agentRuntimeRequest'> & Partial<Pick<KernelClient, 'kernelEpoch'>>,
  configuration: unknown,
) {
  const captured = structuredClone(configuration);
  type Lease = { leaseId: string; epoch: typeof kernel.kernelEpoch };
  let lease: Lease | undefined;
  let opening: Promise<Lease> | undefined;
  let released = false;
  const assertActive = () => {
    if (released) throw new KernelClientError({ code: 'tokenizer-lease-released', message: 'Tokenizer lease was released' });
  };
  const ensureLease = (): Promise<Lease> => {
    assertActive();
    if (lease && lease.epoch === kernel.kernelEpoch && kernel.kernelEpoch !== null) return Promise.resolve(lease);
    if (!opening) {
      lease = undefined;
      opening = kernel.agentRuntimeRequest<{ leaseId: string }, 'runtime.tokenizers.open'>(
        'runtime.tokenizers.open', { configuration: captured }).then(result => {
        // Opening may itself start the kernel. Bind to the epoch that actually
        // returned this resource, rather than the state before that request.
        if (kernel.kernelEpoch === null) throw new KernelClientError({ code: 'kernel-disconnected',
          message: 'Kernel disconnected while opening the tokenizer', retryable: true });
        lease = { leaseId: result.leaseId, epoch: kernel.kernelEpoch };
        return lease;
      }).finally(() => { opening = undefined; });
    }
    return opening;
  };
  await ensureLease();
  return {
    async count(texts: readonly string[]) {
      // Counting immutable text is read-only. A new kernel may reopen this exact
      // tokenizer; accepted inference requests and their owners are never replayed.
      const current = await ensureLease();
      assertActive();
      if (current.epoch !== kernel.kernelEpoch) throw new KernelClientError({ code: 'kernel-disconnected',
        message: 'Kernel changed before tokenizer counting', retryable: true });
      return kernel.agentRuntimeRequest<{ counts: number[]; tokenizer: string }, 'runtime.tokenizers.count'>(
        'runtime.tokenizers.count', { leaseId: current.leaseId, texts: [...texts] });
    },
    async release() {
      if (released) return;
      released = true;
      const current = opening ? await opening.catch(() => undefined) : lease;
      lease = undefined;
      if (current && current.epoch === kernel.kernelEpoch && kernel.kernelEpoch !== null) {
        await kernel.agentRuntimeRequest('runtime.tokenizers.close', { leaseId: current.leaseId });
      }
    },
  };
}
