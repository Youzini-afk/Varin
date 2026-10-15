import { expect, it, vi } from 'vitest';
import { commitPreparedMcpBinding } from './mcp-preparation-commit.js';
import type { KernelClient } from './kernel-client.js';
import type { McpToolLease } from './tool-bridge.js';
import type { LaunchIntent } from './protocol.generated.js';

function fixture() {
  const order: string[] = [];
  const derivations = [{ proof: { execution_id: 'execution', source_authority: { authority_id: 'child' } }, provenance: { servers: {} } }];
  const binding = { reference: 'actual-child', generation: 4, tools: [], routes: {}, resources: {}, provenance: { servers: {} } };
  const releaseDerivations = vi.fn(async () => { order.push('release-proof'); });
  const release = vi.fn();
  const lease = { binding, derivations, releaseDerivations, release } as unknown as McpToolLease;
  const committed = { selection: { mcp_binding: binding } } as unknown as LaunchIntent;
  const read = vi.fn(async () => { order.push('read'); return committed; });
  const request = vi.fn(async () => { order.push('commit'); });
  const register = vi.fn(async () => { order.push('register'); return binding; });
  return { kernel: { agentRuntimeRequest: request, registerMcpOwner: register } as unknown as KernelClient, request, register, release, lease, read, committed, order, releaseDerivations };
}
it('carries original B receipts into the existing prepare request and releases only after the commit', async () => {
  const f = fixture();
  await commitPreparedMcpBinding(f.kernel, 'run', f.lease, f.read, new AbortController().signal);
  expect(f.request).toHaveBeenCalledWith('runtime.launch.mcp.prepare', { runId: 'run', binding: f.lease.binding,
    derivations: f.lease.derivations }, expect.any(AbortSignal));
  expect(f.order).toEqual(['commit', 'register', 'release-proof']); expect(f.read).not.toHaveBeenCalled();
});
it.each(['lost', 'cancelled'] as const)('joins an exact committed binding after %s ACK, without submitting a second prepare', async mode => {
  const f = fixture(), controller = new AbortController();
  f.request.mockImplementationOnce(async () => { f.order.push('commit'); if (mode === 'cancelled') controller.abort(); throw new Error('response lost'); });
  const pending = commitPreparedMcpBinding(f.kernel, 'run', f.lease, f.read, controller.signal);
  if (mode === 'cancelled') await expect(pending).rejects.toBeDefined(); else await pending;
  expect(f.order).toEqual(mode === 'cancelled' ? ['commit', 'read'] : ['commit', 'read', 'register', 'release-proof']); expect(f.request).toHaveBeenCalledOnce();
});
it.each(['different', 'unavailable'] as const)('keeps the original proof duty when commit readback is %s', async mode => {
  const f = fixture(); f.request.mockRejectedValueOnce(new Error('response lost'));
  if (mode === 'unavailable') f.read.mockRejectedValueOnce(new Error('offline'));
  else f.read.mockResolvedValueOnce({ ...f.committed, selection: { ...f.committed.selection, mcp_binding: { ...f.lease.binding, generation: 99 } } });
  await expect(commitPreparedMcpBinding(f.kernel, 'run', f.lease, f.read, new AbortController().signal)).rejects.toThrow('response lost');
  expect(f.releaseDerivations).not.toHaveBeenCalled(); expect(f.request).toHaveBeenCalledOnce();
});
it('an unconfirmed proof cleanup keeps the committed exact live owner registered for the original duty to retry', async () => {
  const f = fixture();
  f.releaseDerivations.mockRejectedValueOnce(new Error('proof release ACK lost'));
  await expect(commitPreparedMcpBinding(f.kernel, 'run', f.lease, f.read, new AbortController().signal)).resolves.toEqual(f.lease.binding);
  expect(f.register).toHaveBeenCalledExactlyOnceWith('run', f.lease);
  expect(f.release).not.toHaveBeenCalled();
  expect(f.order).toEqual(['commit', 'register']);
  expect(f.releaseDerivations).toHaveBeenCalledOnce();
  expect(f.read).not.toHaveBeenCalled();
});

it('a slow proof-release tail cannot block starting the already registered exact child owner', async () => {
  const f = fixture(); let finish!: () => void;
  const cleanup = new Promise<void>(resolve => { finish = resolve; });
  f.releaseDerivations.mockImplementationOnce(() => cleanup);
  await expect(commitPreparedMcpBinding(f.kernel, 'run', f.lease, f.read, new AbortController().signal)).resolves.toEqual(f.lease.binding);
  expect(f.register).toHaveBeenCalledExactlyOnceWith('run', f.lease);
  expect(f.releaseDerivations).toHaveBeenCalledOnce(); expect(f.release).not.toHaveBeenCalled();
  finish(); await cleanup;
});
