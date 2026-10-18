import { expect, it } from 'vitest';
import { createMcpResourceRecovery } from './mcp-resource-recovery.js';
import type { McpResourcePending } from './protocol.generated.js';
const endpoint = { server: 'peer', resourceKey: 'original', configurationVersion: 'definition', credentialVersion: 'credential' };
const binding = { operationId: 'operation', executionOwner: { kind: 'external' as const, identity: 'mcp', epoch: 'original' }, endpoint, schemaVersion: 'schema', uri: 'opaque:resource' };
function fixture() {
  const calls: string[] = [], policies: unknown[] = [];
  let live = true, controlsDrained = true, retire = false;
  const client = {
    async service(input: { operation: { action: { kind: string; binding: unknown } } }, signal?: AbortSignal) {
      expect(input).toMatchObject({ authorityId: 'original-source', coordinatorHostId: 'a', resourceEpoch: 'original-b-epoch' });
      expect(input.operation.action.binding).toEqual(binding);
      const action = input.operation.action; calls.push(action.kind);
      if (action.kind === 'resource_inspect') return { ok: true, executorStopped: true, value: { live, released: false, listenerId: 'original-listener', revision: 5,
        receipt: { requestHash: 'original-hash', outcome: { kind: 'subscribed', listenerId: 'original-listener', acknowledgement: { original: true } } } } };
      if (action.kind === 'resource_release') return { ok: true, executorStopped: true, value: { controlsDrained, retire, release: { status: 'unknown' } } };
      if (action.kind === 'resource_watch') return await new Promise((_, reject) => {
        const abort = () => reject(signal?.reason); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      });
      throw new Error('No creation or replacement is allowed');
    },
    async release(input: { authorityId: string }) { calls.push('source-retire'); expect(input.authorityId).toBe('original-source'); return { phase: 'retired' }; },
  };
  const recover = createMcpResourceRecovery({ kernel: { async agentRuntimeRequest(method: string) {
    expect(method).toBe('runtime.mcp.resource.context'); return { threadId: 'thread', source: null, binding: { provenance: { servers: { peer: {
      resource_key: endpoint.resourceKey, definition_version: endpoint.configurationVersion, owner: { resource_owner: { kind: 'managed_host', hostId: 'b' },
        source_authority: { coordinator_host_id: 'a', authority_id: 'original-source', resource_epoch: 'original-b-epoch' },
        configuration: { config_cwd: '/only-on-b', project_trusted: true }, execution_scope: 'workspace' },
    } } } } };
  } }, authority: {}, agentDir: '/a-agent', hostId: 'a', runtime: { coordinatorHostId: 'a', managedSource: async () => client },
    admitWorkspaceRegistration: async () => { throw new Error('B path must never be admitted on A'); }, projectTrusted: () => false,
    validateLiveSource: async () => { throw new Error('B root must never be inspected on A'); },
    currentPolicy: async (cwd: string, trusted: boolean) => { policies.push([cwd, trusted]); return { mode: 'bypass', rules: [] }; },
  } as never);
  const op: McpResourcePending = { revision: 1, operationId: 'operation', runId: 'ended-run', threadId: 'thread', branchId: 'branch', cancelRequested: false,
    subscription: { binding, sourceScope: 'workspace', acceptanceRef: 'ack', listenerId: 'old-a-listener', availability: 'gap', localReleased: true,
      remoteCleanup: 'not_requested', lastEventCursor: null, problem: null, mcpHolderReleased: false } };
  return { recover, op, calls, policies, absent: () => { live = false; }, undrained: () => { controlsDrained = false; }, retiring: () => { retire = true; } };
}
it('recovers only the original target observer and uses A policy without touching B configuration paths', async () => {
  const f = fixture(), signal = new AbortController().signal;
  const observer = await f.recover(f.op, signal, () => {});
  expect(observer.listenerId).not.toBe('old-a-listener'); expect(observer.acknowledgement).toEqual({ original: true });
  expect(f.policies).toEqual([['/a-agent', false]]); observer.disconnect!();
  expect(f.calls).not.toContain('resource_release');
  f.absent(); await expect(f.recover(f.op, signal, () => {})).rejects.toThrow('original-observation-unavailable');
  expect(f.calls.every(kind => ['resource_inspect', 'resource_watch'].includes(kind))).toBe(true);
});
it('recalls a cancelled unaccepted original ACK and requires real holder drain before final retirement', async () => {
  const f = fixture(), signal = new AbortController().signal;
  f.op.cancelRequested = true; f.op.subscription.acceptanceRef = null;
  expect(await f.recover.recoverCreation(f.op, signal)).toMatchObject({ kind: 'subscribed', acknowledgement: { original: true } });
  f.retiring(); expect(await f.recover.cleanup(f.op, signal)).toEqual({ status: 'unknown' });
  expect(f.calls.slice(-2)).toEqual(['resource_release', 'source-retire']);
  f.undrained(); await expect(f.recover.cleanup(f.op, signal)).rejects.toThrow('cleanup_receipt_invalid');
  expect(f.calls.at(-1)).toBe('resource_release');
});
