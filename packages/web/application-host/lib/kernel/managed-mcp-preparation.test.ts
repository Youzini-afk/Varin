import { expect, it, vi } from 'vitest';
import { createManagedMcpPreparer, selectMcpServers } from './managed-mcp-preparation.js';
import type { createManagedMcpLease } from './managed-mcp-lease.js';
import type { AgentRuntimeClient, McpPreparation } from './agent-runtime-client.js';
import type { McpBinding } from './protocol.generated.js';

const owner = { kind: 'managed_host' as const, hostId: 'B', connectionId: 'connection', endpointIdentity: 'endpoint' };
const input: McpPreparation = { runId: 'run', threadId: 'thread', source: { runId: 'run', resourceOwner: owner,
  workspaceId: 'workspace', executionWorkspaceId: 'workspace', mode: 'materialized', branchId: 'branch', revision: 3, tools: [] } };
function fixture() {
  const changed: string[] = [];
  let releases = 0, calls = 0, errors = 0;
  let resolve!: (value: Awaited<ReturnType<typeof createManagedMcpLease>>) => void;
  const ready = new Promise<Awaited<ReturnType<typeof createManagedMcpLease>>>(done => { resolve = done; });
  const access = { binding: { authorityId: 'original', resourceEpoch: 'epoch' }, client: {
    service: (_input: unknown, signal: AbortSignal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (signal.aborted) reject(signal.reason);
    }),
  } };
  const runtime = { coordinatorHostId: 'A', withManagedSourceAuthority: async (_run: string, _source: unknown, consume: (value: typeof access) => Promise<unknown>) => consume(access) } as unknown as AgentRuntimeClient;
  const manager = createManagedMcpPreparer({ runtime: () => runtime, changed: run => changed.push(run), onError: () => { errors++; },
    createLease: async () => { calls++; return ready; } });
  const value = { lease: { release: () => { releases++; } }, snapshot: { incarnation: 'original-b-view', revision: 0 } } as Awaited<ReturnType<typeof createManagedMcpLease>>;
  return { manager, changed, value, resolve: () => resolve(value), counts: () => ({ calls, releases, errors }) };
}
it('lets a fresh Run use ready global tools while B prepares, then publishes a real readiness wake', async () => {
  const f = fixture();
  expect(await f.manager.prepare(input)).toBeUndefined();
  expect(f.changed).toEqual([]); expect(f.counts().calls).toBe(1);
  f.resolve(); await vi.waitFor(() => expect(f.changed).toEqual(['run']));
  expect(await f.manager.prepare(input)).toBe(f.value.lease);
  f.manager.release('run'); expect(f.counts().releases).toBe(0);
  f.value.lease.release(); expect(f.counts().releases).toBe(1);
});
it('releases a late initial B view after its Run has been closed without publishing readiness', async () => {
  const f = fixture(); await f.manager.prepare(input); f.manager.release('run');
  f.resolve(); await vi.waitFor(() => expect(f.counts().releases).toBe(1));
  expect(f.changed).toEqual([]); expect(f.counts().errors).toBe(0);
});
it('does not consume an initial retained lease when a cancelled caller asks for it', async () => {
  const f = fixture(); await f.manager.prepare(input); f.resolve(); await vi.waitFor(() => expect(f.changed).toHaveLength(1));
  const cancelled = new AbortController(); cancelled.abort();
  await expect(f.manager.prepare(input, cancelled.signal)).rejects.toBeDefined();
  expect(await f.manager.prepare(input)).toBe(f.value.lease);
  f.manager.close(); f.value.lease.release(); expect(f.counts().releases).toBe(1);
});
it('cuts mixed frozen bindings by original owner while retaining only the selected direct resources', () => {
  const server = (resourceOwner: typeof owner | { kind: 'local' }, resource: string) => ({
    owner: { resource_owner: resourceOwner, configuration: { agent_dir: '/agent', config_cwd: '/project', project_trusted: true }, execution_scope: 'workspace' as const, source_authority: resourceOwner.kind === 'managed_host' ? { coordinator_host_id: 'A', authority_id: 'original', resource_epoch: 'epoch' } : null },
    definition_version: 'definition', resource_key: resource,
  });
  const binding = { reference: 'mixed', generation: 2,
    provenance: { servers: { local: server({ kind: 'local' }, 'a'), remote: server(owner, 'b') } },
    resources: { local_tool: 'a', remote_tool: 'b', 'server:local': 'a', 'server:remote': 'b' },
    tools: [{ name: 'local_tool' }, { name: 'remote_tool' }, { name: 'gateway' }],
    routes: { local_tool: { kind: 'direct' }, remote_tool: { kind: 'direct' }, gateway: { kind: 'discovery', argument: 'server' } },
  } as unknown as McpBinding;
  const selected = selectMcpServers(binding, owner => owner.kind === 'managed_host');
  expect(Object.keys(selected.provenance.servers)).toEqual(['remote']);
  expect(selected.tools.map(tool => tool.name)).toEqual(['remote_tool', 'gateway']);
  expect(selected.resources).toEqual({ remote_tool: 'b', 'server:remote': 'b' });
  expect(Object.keys(binding.provenance.servers)).toEqual(['local', 'remote']);
});
it('forwards exact view revocations and caches an event racing lease registration', async () => {
  const received: unknown[] = [], changed: string[] = [];
  let announce!: (reply: unknown) => void, second!: Parameters<typeof createManagedMcpLease>[0];
  let calls = 0;
  const access = { binding: { authorityId: 'original', resourceEpoch: 'epoch' }, client: {
    service: (_input: unknown, signal: AbortSignal) => new Promise((resolve, reject) => {
      announce = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (signal.aborted) reject(signal.reason);
    }),
  } };
  const runtime = { coordinatorHostId: 'A', withManagedSourceAuthority: async (_run: string, _source: unknown, consume: (value: typeof access) => Promise<unknown>) => consume(access) } as unknown as AgentRuntimeClient;
  const manager = createManagedMcpPreparer({ runtime: () => runtime, changed: run => changed.push(run), onError: () => {},
    createLease: async admission => {
      if (++calls === 1) admission.observeRevocations('first', facts => received.push(['first', facts])); else second = admission;
      return { lease: { release() {} }, snapshot: { incarnation: 'original', revision: 0 } } as Awaited<ReturnType<typeof createManagedMcpLease>>;
    } });
  await manager.prepare(input); await vi.waitFor(() => expect(changed).toHaveLength(1));
  await manager.prepare(input); // consume original retained view
  const facts = { tools: [{ name: 'tool', schemaVersion: 'v1' }], services: [] };
  announce({ ok: true, value: { incarnation: 'original', revision: 1, revocations: { first: facts, second: facts } } });
  await vi.waitFor(() => expect(received).toEqual([['first', facts]]));
  await manager.prepare(input);
  const unsubscribe = second.observeRevocations('second', value => received.push(['second', value]));
  expect(received).toEqual([['first', facts], ['second', facts]]);
  unsubscribe(); manager.close();
});
