import type { KernelProcessObserver, KernelProcessSubscription } from '../kernel/kernel-client.js';
import { KERNEL_MAX_FRAME_BYTES, KERNEL_PROTOCOL_VERSION, type KernelProcessStreamEvent } from '../kernel/protocol.generated.js';
import type { ManagedSourceProcessControl, ManagedSourceProcessSubscription } from './managed-remote-types.js';

/** Native data/control credits cross the network separately; consuming a body never grants credit. */
export async function consumeManagedProcessStream(response: Response, input: ManagedSourceProcessSubscription,
  observer: KernelProcessObserver, control: (input: ManagedSourceProcessControl) => Promise<unknown>): Promise<KernelProcessSubscription> {
  if (!response.body || response.headers.get('content-type')?.split(';')[0] !== 'application/x-ndjson') throw new Error('Managed process stream is unavailable');
  const reader = response.body.getReader();
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  let resolveClosed!: () => void, rejectClosed!: (error: Error) => void;
  const ready = new Promise<void>((yes, no) => { resolveReady = yes; rejectReady = no; });
  const closed = new Promise<void>((yes, no) => { resolveClosed = yes; rejectClosed = no; });
  void closed.catch(() => undefined);
  let opened = false, closing: Promise<void> | undefined;
  const sequence = { data: 0, control: 0 };
  const handle: KernelProcessSubscription = {
    closed,
    acknowledge: async (stream, value) => { if (!closing) await control({ ...input, kind: 'ack', stream, sequence: value }); },
    close: () => {
      closing ??= (async () => {
        try { await control({ ...input, kind: 'close' }); resolveClosed(); }
        catch (error) { rejectClosed(error instanceof Error ? error : new Error(String(error))); throw error; }
        finally { await reader.cancel().catch(() => undefined); }
      })();
      return closing;
    },
  };
  const consume = (line: string) => {
    const frame = JSON.parse(line) as Record<string, unknown>;
    if (frame.kind === 'error') throw new Error(typeof frame.message === 'string' ? frame.message : 'Original process stream failed');
    if (frame.kind === 'ready' && !opened && frame.subscriptionId === input.subscriptionId && frame.resourceEpoch === input.resourceEpoch) {
      opened = true; resolveReady(); return;
    }
    const event = frame.event as KernelProcessStreamEvent;
    if (!opened || frame.kind !== 'event' || !event || event.v !== KERNEL_PROTOCOL_VERSION || event.kind !== 'process-event'
      || event.kernelEpoch !== input.resourceEpoch || event.processId !== input.processId || event.subscriptionId !== input.subscriptionId
      || event.grantId !== input.authorityId || !['data', 'control', 'closed'].includes(event.stream)
      || !Number.isSafeInteger(event.sequence) || event.sequence < 0) throw new Error('Original process stream identity changed');
    if (event.stream !== 'closed') {
      if (event.sequence !== sequence[event.stream] + 1) throw new Error('Original process stream has a credit gap');
      sequence[event.stream] = event.sequence;
    }
    observer(event, () => event.stream === 'closed' ? Promise.resolve() : handle.acknowledge(event.stream, event.sequence));
  };
  void (async () => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '';
    while (!closing) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('Original process stream disconnected; execution remains with its owner');
      pending += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > KERNEL_MAX_FRAME_BYTES) throw new Error('Managed process frame exceeds native frame bound');
        consume(line);
      }
      if (Buffer.byteLength(pending) > KERNEL_MAX_FRAME_BYTES) throw new Error('Managed process frame exceeds native frame bound');
    }
  })().catch(error => {
    const failure = error instanceof Error ? error : new Error(String(error));
    rejectReady(failure);
    if (!closing) { rejectClosed(failure); void handle.close().catch(() => undefined); }
  });
  try { await ready; return handle; }
  catch (error) { await reader.cancel().catch(() => undefined); throw error; }
}
