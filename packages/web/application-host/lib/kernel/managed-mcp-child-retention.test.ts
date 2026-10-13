import { expect, it, vi } from 'vitest';
import { createManagedMcpService } from '../harness/managed-mcp-service.js';
import { releaseManagedChildDependencies, releaseManagedChildReference } from './managed-mcp-child-retention.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { McpBinding, SourceMcpChildBinding, SourceResourceOwner } from './protocol.generated.js';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';

const binding: SourceMcpChildBinding = { operationId: 'original-dispatch', parentRunId: 'original-run',
  executionOwner: { kind: 'kernel' }, executionEpoch: 7 };
const owner = (hostId: string): Extract<SourceResourceOwner, { kind: 'managed_host' }> => ({
  kind: 'managed_host', hostId, connectionId: `connection:${hostId}`, endpointIdentity: `endpoint:${hostId}`,
});
const selection: McpBinding = { reference: 'original-cut', generation: 1, tools: [], routes: {}, resources: {},
  provenance: { servers: Object.fromEntries(['B', 'C'].map(hostId => [hostId, { definition_version: 'original', resource_key: `resource:${hostId}`,
    owner: { resource_owner: owner(hostId), source_authority: { coordinator_host_id: 'A', authority_id: `source:${hostId}`, resource_epoch: 'original-epoch' },
      execution_scope: 'workspace', configuration: { agent_dir: '/agent', config_cwd: '/project', project_trusted: true } } }])) } };

it('cleans each original Source through the real target owner after lost ACK and withdrawn read authority', async () => {
  const references = new Map<string, { released: boolean }>();
  const facts: unknown[] = [], retired: string[] = [];
  let loseC = true;
  const clients = new Map<string, ManagedSourceClient>();
  for (const hostId of ['B', 'C']) {
    references.set(hostId, { released: false });
    const target = createManagedMcpService({ hostId, agentDir: '/agent',
      compositions: { observe: vi.fn(() => { throw new Error('cleanup must not prepare another composition'); }) },
      kernel: { sourceRequest: vi.fn(async (method: string, params: unknown) => {
        const input = params as Record<string, unknown>;
        expect(method).toBe('source.mcp.child'); expect(input.action).toBe('release');
        expect(input.authorityId).toBe(`source:${hostId}`); expect(input.resourceEpoch).toBe('original-epoch');
        expect(input.binding).toEqual(binding); facts.push([hostId, structuredClone(input.binding)]);
        references.get(hostId)!.released = true;
        if (hostId === 'C' && loseC) { loseC = false; throw new Error('original durable release ACK lost'); }
        return { reference: { binding, selectionRef: null, released: true }, created: false,
          phase: 'draining', grantState: 'revoked', selection: null };
      }) } as unknown as KernelClient,
      admitWorkspaceRegistration: async () => { throw new Error('cleanup cannot require current project admission'); },
      admitSource: async () => { throw new Error('cleanup cannot re-admit old grant'); }, projectTrusted: () => false,
    });
    const scope = { principal: { principalId: 'authenticated-original', capabilities: [] }, coordinatorHostId: 'A',
      authorityId: `source:${hostId}`, resourceEpoch: 'original-epoch' };
    clients.set(hostId, { service: async (request: { operation: { action: unknown } }) =>
      target.childContinuation(scope as never, request.operation.action as never),
      release: async () => { await target.release(scope); retired.push(hostId); },
    } as unknown as ManagedSourceClient);
  }
  const runtime = { coordinatorHostId: 'A', managedSource: async (selected: { hostId: string }) => clients.get(selected.hostId)! } as unknown as AgentRuntimeClient;
  await expect(releaseManagedChildDependencies(runtime, binding, selection)).rejects.toThrow('Original MCP child dependency cleanup failed');
  expect([...references.values()].every(reference => reference.released)).toBe(true);
  expect(retired).toEqual(['B']);
  await releaseManagedChildDependencies(runtime, binding, selection);
  expect(retired).toEqual(['B', 'B', 'C']);
  expect(facts.every(value => (value as unknown[])[1] && JSON.stringify((value as unknown[])[1]) === JSON.stringify(binding))).toBe(true);
});

it('requires explicit original dependency drainage before any Source retirement', async () => {
  const release = vi.fn();
  const client = { service: async () => ({ ok: true, value: { retire: true }, executorStopped: true }), release } as unknown as ManagedSourceClient;
  await expect(releaseManagedChildReference(client, { coordinatorHostId: 'A', authorityId: 'source:B', resourceEpoch: 'original-epoch' }, binding))
    .rejects.toThrow('mcp_child_dependency_cleanup_unconfirmed');
  expect(release).not.toHaveBeenCalled();
});
