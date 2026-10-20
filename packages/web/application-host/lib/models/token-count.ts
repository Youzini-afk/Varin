import type { KernelClient } from '../kernel/kernel-client.js';

/** The same native counter used by conversation compaction, held for one consumer. */
export async function acquireTokenCounter(
  kernel: Pick<KernelClient, 'agentRuntimeRequest'> & Partial<Pick<KernelClient, 'kernelEpoch'>>,
  configuration: unknown,
) {
  const epoch = kernel.kernelEpoch;
  const { leaseId } = await kernel.agentRuntimeRequest<{ leaseId: string }, 'runtime.tokenizers.open'>(
    'runtime.tokenizers.open', { configuration });
  let released = false;
  return {
    async count(texts: readonly string[]) {
      if (released || kernel.kernelEpoch !== epoch) throw new Error('Tokenizer lease is unavailable');
      return kernel.agentRuntimeRequest<{ counts: number[]; tokenizer: string }, 'runtime.tokenizers.count'>(
        'runtime.tokenizers.count', { leaseId, texts: [...texts] });
    },
    async release() {
      if (released) return;
      released = true;
      if (kernel.kernelEpoch === epoch) await kernel.agentRuntimeRequest('runtime.tokenizers.close', { leaseId });
    },
  };
}
