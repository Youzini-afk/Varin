import { expect, it, vi } from 'vitest';
import { FileObservationService } from './file-observation-service.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { DocumentsFileObservationOwner } from './file-observation-owner.js';
import type { AgentRuntimeStreamEvent, FileObservationBinding, Followup } from './protocol.generated.js';

it('retains in-flight invalidations, pauses without losing them, and cancels only the same observation before release', async () => {
  const binding: FileObservationBinding = { followupId: 'definition', generation: 1, sourceIndex: 0,
    receiptId: 'receipt', failureCode: null, observationRevision: 1, definitionRevision: 1, action: 'observe', watchId: 'watch', position: null,
    target: { receiptId: 'receipt', followupId: 'definition', sourceIndex: 0, sourceRunId: 'source', threadId: 'thread',
      path: 'result.txt', immutable: false, physicalRoot: { hostId: 'host', canonicalRoot: '/original', rootId: 'root' },
      source: { mode: 'materialized', workspace_id: 'workspace', execution_workspace_id: 'workspace', branch_id: 'branch', revision: 1, live_root: null } } };
  let event: (event: AgentRuntimeStreamEvent) => void = () => undefined;
  let listed = true; let cursor = 1;
  const reads: Array<{ signal: AbortSignal; resolve: (value: { accepted: boolean; followup: Followup }) => void }> = [];
  const observe = vi.fn(async (_input, signal: AbortSignal) => new Promise<{ accepted: boolean; followup: Followup }>((resolve, reject) => {
    reads.push({ signal, resolve });
    signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
  }));
  const release = vi.fn(async (_key: unknown) => { listed = false; return { released: true }; });
  const runtime = { onEvent: (listener: typeof event) => { event = listener; return () => undefined; }, onExit: () => () => undefined,
    onReady: () => () => undefined, fileFollowups: async () => ({ bindings: listed ? [structuredClone(binding)] : [], nextCursor: null }),
    observeFileFollowup: observe, releaseFileFollowup: release } as unknown as AgentRuntimeClient;
  const errors = vi.fn(); const stop = vi.fn();
  const service = new FileObservationService(runtime, { has: () => true, stop } as unknown as DocumentsFileObservationOwner, errors);
  const emit = () => event({ v: 1, kind: 'runtime-event', kernelEpoch: 'epoch', stream: 'durable', cursor: cursor++ });
  const settle = (index: number) => reads[index]!.resolve({ accepted: true, followup: { revision: binding.definitionRevision } as Followup });
  try {
    await service.recover(); await vi.waitFor(() => expect(reads).toHaveLength(1));
    service.changed('receipt'); binding.observationRevision++; settle(0);
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    settle(1); await new Promise(resolve => setImmediate(resolve));
    expect(reads).toHaveLength(2); // Finishing the unchanged read does not excite another read.
    binding.action = 'paused'; binding.definitionRevision++; emit();
    service.changed('receipt'); await new Promise(resolve => setImmediate(resolve)); expect(reads).toHaveLength(2);
    binding.action = 'observe'; binding.definitionRevision++; emit();
    await vi.waitFor(() => expect(reads).toHaveLength(3));
    binding.action = 'release'; binding.definitionRevision++; emit();
    await vi.waitFor(() => expect(reads[2]!.signal.aborted).toBe(true));
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(release.mock.calls[0]![0]).toMatchObject({ receiptId: 'receipt', sourceIndex: 0, followupId: 'definition' });
    expect(errors).not.toHaveBeenCalled();
  } finally { await service.stop(); }
  expect(stop).toHaveBeenCalledOnce();
});
