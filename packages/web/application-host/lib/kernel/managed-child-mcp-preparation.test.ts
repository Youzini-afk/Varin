import { expect, it, vi } from 'vitest';
import { createManagedChildMcpPreparer, derivedChildMcpSelection, releaseManagedChildDerivations } from './managed-child-mcp-preparation.js';
import { selectMcpServers } from './managed-mcp-preparation.js';
import type { AgentRuntimeClient, McpPreparation } from './agent-runtime-client.js';
import type { McpBinding, McpChildDerivationReceipt, DelegatedExecution } from './protocol.generated.js';
import type { createManagedMcpLease } from './managed-mcp-lease.js';

function fixture() {
  const owner = { kind: 'managed_host' as const, hostId: 'B', connectionId: 'connection', endpointIdentity: 'endpoint' };
  const parent = { coordinator_host_id: 'A', authority_id: 'parent-authority', resource_epoch: 'parent-epoch' };
  const current = { ...parent, authority_id: 'child-authority', resource_epoch: 'child-epoch' };
  const server = { owner: { resource_owner: owner, source_authority: parent, execution_scope: 'workspace' as const,
    configuration: { agent_dir: '/b-agent', config_cwd: '/b-project', project_trusted: true } },
    definition_version: 'original-definition', resource_key: 'parent-resource' };
  const tool = { name: 'frozen_alias', version: 'schema-v1', description: 'Original tool', schema: { type: 'object' }, output_schema: null, metadata: null };
  const binding: McpBinding = { reference: 'original-mixed', generation: 4, tools: [tool], routes: { frozen_alias: { kind: 'direct' } },
    resources: { frozen_alias: 'parent-resource', 'server:project': 'parent-resource', 'server:global': 'a-resource' },
    provenance: { servers: { project: server, global: { ...server, resource_key: 'a-resource',
      owner: { ...server.owner, resource_owner: { kind: 'local' }, source_authority: null, execution_scope: 'global',
        configuration: { agent_dir: '/a-agent', config_cwd: '/a-agent', project_trusted: false } } } } } };
  const source = { resource_owner: owner, workspace_id: 'project', execution_workspace_id: 'child-root', mode: 'materialized',
    live_root: null, branch_id: 'child-branch', revision: 3, environment_run_id: 'child-run' };
  const pin = { pin_id: 'child-pin', source };
  const child = { execution_id: 'child-execution', child_operation_id: 'dispatch-op', parent_run_id: 'parent-run',
    child_thread_id: 'child-thread', child_branch_id: 'child-branch', receipt: { run_id: 'child-run' },
    trigger: { kind: 'dispatch' }, source: { kind: 'ready', selection: source, pin }, launch: { mcp_binding: binding } } as unknown as DelegatedExecution;
  const operation = { id: 'dispatch-op', run_id: 'parent-run', execution_owner: { kind: 'host', host_id: 'A', incarnation: 'host-epoch' }, epoch: 9 };
  const origin = { kind: 'dispatch', parent_source_authority: parent, binding: { operationId: operation.id,
    parentRunId: operation.run_id, executionOwner: operation.execution_owner, executionEpoch: operation.epoch } };
  const provenance = structuredClone({ servers: { project: { ...server, resource_key: 'child-resource', owner: { ...server.owner, source_authority: current } } } });
  const physicalRoot = { root_id: 'b-root', canonical_path: '/b-private-child' };
  const receipt = { proof: { execution_id: child.execution_id, child_run_id: 'child-run', child_thread_id: child.child_thread_id,
    source_authority: current, source, physical_root: physicalRoot, pin, origin, selection: selectMcpServers(binding, owner => owner.kind === 'managed_host') }, provenance } as unknown as McpChildDerivationReceipt;
  const input: McpPreparation = { runId: 'child-run', threadId: 'child-thread', fixed: true, child, delegatedBinding: binding,
    source: { resourceOwner: owner, runId: 'child-run', workspaceId: 'project', executionWorkspaceId: 'child-root',
      mode: 'materialized', branchId: 'child-branch', revision: 3, environmentRunId: 'child-run', tools: [] } };
  const releases: string[] = [], calls: Parameters<typeof createManagedMcpLease>[0][] = [], scopes: unknown[] = [];
  let lostRelease = false;
  const service = vi.fn(async (request, signal?: AbortSignal) => {
    if (request.operation.action.kind === 'derivation_release') {
      releases.push(request.authorityId);
      if (lostRelease) { lostRelease = false; throw new Error('release response lost'); }
      return { ok: true, value: { released: true } };
    }
    return new Promise((_, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      if (signal!.aborted) reject(signal!.reason);
    });
  });
  const inspection = { purpose: 'mcp_owner', phase: 'retired', scope: { kind: 'run', threadId: 'child-thread', runId: 'child-run', epoch: 1 },
    binding: { authorityId: current.authority_id, resourceEpoch: current.resource_epoch, source, physicalRoot } };
  const access = { binding: inspection.binding, client: { service, inspectScope: vi.fn(async () => [inspection]), bind: vi.fn() } };
  const runtime = { coordinatorHostId: 'A', operation: vi.fn(async () => operation), managedSource: vi.fn(async () => access.client),
    launch: vi.fn(async () => ({ selection: { source, mcp_binding: binding } })),
    withManagedSourceAuthority: vi.fn(async (_run, selected, consume, _signal, options) => { scopes.push({ selected, options }); return consume(access); }) } as unknown as AgentRuntimeClient;
  const release = vi.fn(), drain = vi.fn(async () => {});
  const createLease = vi.fn(async options => {
    calls.push(options);
    return { lease: { release, releaseAndDrain: drain }, snapshot: { incarnation: 'b-instance', revision: 0, binding: { provenance } },
      ...(options.derivation ? { receipt } : {}) } as unknown as Awaited<ReturnType<typeof createManagedMcpLease>>;
  });
  const prepare = createManagedChildMcpPreparer({ runtime: () => runtime, createLease });
  return { prepare, runtime, receipt, input, binding, child, scopes, calls, releases, access, drain, release,
    loseRelease: () => { lostRelease = true; } };
}

it('derives against the actual child Source and only relocates managed authority/resources in the frozen mixed cut', async () => {
  const f = fixture(), prepared = await f.prepare(f.input);
  expect(f.scopes).toMatchObject([{ options: { purpose: 'mcp_owner' } }]);
  expect((f.scopes[0] as { options: unknown }).options).not.toHaveProperty('original');
  expect(f.calls[0]!.derivation).toEqual({ executionId: f.child.execution_id, origin: f.receipt.proof.origin });
  expect(f.calls[0]).not.toHaveProperty('selection');
  const selected = derivedChildMcpSelection(f.binding, prepared.receipt!);
  expect(selected.tools).toEqual(f.binding.tools); expect(selected.routes).toEqual(f.binding.routes);
  expect(selected.provenance.servers.global).toEqual(f.binding.provenance.servers.global);
  expect(selected.resources).toEqual({ frozen_alias: 'child-resource', 'server:project': 'child-resource', 'server:global': 'a-resource' });
  expect(f.binding.resources.frozen_alias).toBe('parent-resource');
  await prepared.releaseDerivation(); expect(f.releases).toEqual(['child-authority']);
  await prepared.lease.releaseAndDrain(); expect(f.drain).toHaveBeenCalledOnce();
});

it.each(['definition', 'configuration', 'selection'] as const)('rejects %s changes and drains the actual candidate', async change => {
  const f = fixture();
  if (change === 'definition') f.receipt.provenance.servers.project!.definition_version = 'latest';
  if (change === 'configuration') f.receipt.provenance.servers.project!.owner.configuration.config_cwd = '/parent-cwd';
  if (change === 'selection') f.receipt.proof.selection.routes.frozen_alias = { kind: 'direct_task' };
  await expect(f.prepare(f.input)).rejects.toThrow(/changed/);
  expect(f.drain).toHaveBeenCalledOnce(); expect(f.releases).toEqual([]);
});

it('restores an already committed child binding using its exact current Source without deriving old dispatch again', async () => {
  const f = fixture();
  const requiredBinding = derivedChildMcpSelection(f.binding, f.receipt);
  const { delegatedBinding: _old, ...input } = f.input;
  const prepared = await f.prepare({ ...input, requiredBinding });
  expect(f.calls[0]).not.toHaveProperty('derivation');
  expect(f.calls[0]!.restoration).toEqual({ executionId: f.child.execution_id });
  expect(f.calls[0]!.selection).toEqual(selectMcpServers(requiredBinding, owner => owner.kind === 'managed_host'));
  expect(f.scopes).toMatchObject([{ options: { purpose: 'mcp_owner', original: f.receipt.proof.source_authority } }]);
  expect(f.runtime.operation).not.toHaveBeenCalled(); expect(prepared.receipt).toBeUndefined();
  await prepared.releaseDerivation(); await prepared.lease.releaseAndDrain();
});

it('continuation carries its frozen previous-Run cut rather than dispatch retention', async () => {
  const f = fixture();
  f.child.trigger = { kind: 'user_continuation', previous_run_id: 'predecessor-run' } as DelegatedExecution['trigger'];
  f.receipt.proof.origin = { kind: 'continuation', previous_run_id: 'predecessor-run' };
  const prepared = await f.prepare(f.input);
  expect(f.calls[0]!.derivation).toEqual({ executionId: f.child.execution_id, origin: f.receipt.proof.origin,
    selection: selectMcpServers(f.binding, owner => owner.kind === 'managed_host') });
  expect(f.runtime.operation).not.toHaveBeenCalled(); await prepared.lease.releaseAndDrain();
});

it('does not prepare project MCP from an unmaterialized Source', async () => {
  const f = fixture();
  await expect(f.prepare({ ...f.input, source: { ...f.input.source!, mode: 'fixed_branch' } as NonNullable<McpPreparation['source']> })).rejects.toThrow('mcp_child_materialized_source_required');
  expect(f.runtime.withManagedSourceAuthority).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
});

it('terminal cleanup rediscovers retired child authorities and retries exact proof release after lost ACK without acquiring', async () => {
  const f = fixture(); f.loseRelease();
  await expect(releaseManagedChildDerivations(f.runtime, f.child)).rejects.toThrow('Child MCP proof cleanup failed');
  await releaseManagedChildDerivations(f.runtime, f.child);
  expect(f.releases).toEqual(['child-authority', 'child-authority']);
  expect(f.runtime.managedSource).toHaveBeenCalledTimes(2); expect(f.access.client.bind).not.toHaveBeenCalled();
  expect(f.runtime.withManagedSourceAuthority).not.toHaveBeenCalled();
});

it('a refused FixedBranch child has no derivation cleanup to reacquire or keep its terminal duty open', async () => {
  const f = fixture();
  const launch = await f.runtime.launch('child-run');
  launch!.selection.source!.mode = 'fixed_branch';
  await releaseManagedChildDerivations(f.runtime, f.child);
  expect(f.runtime.managedSource).not.toHaveBeenCalled();
  expect(f.access.client.inspectScope).not.toHaveBeenCalled(); expect(f.releases).toEqual([]);
});
