import { describe, expect, it, vi } from 'vitest';
import type { McpAuthority, McpAuthorityAcquireOptions, McpAuthorityOwnedLease, McpAuthorityScope,
  McpAuthorityTool, McpCompositionSnapshot, McpDefinitionLease } from '@varin/pi-host/mcp-authority';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { McpBinding, McpChildDerivationProof, SourceMcpChildBinding, SourceMcpChildResult,
  SourceMcpDerivationParams, SourceMcpDerivationResult } from '../kernel/protocol.generated.js';
import type { ManagedSourceLocalScope } from './managed-remote-types.js';
import type { ManagedMcpAction, ManagedMcpDerivationSnapshot, ManagedMcpReply } from './managed-mcp-contract.js';
import { createManagedMcpService } from './managed-mcp-service.js';

const resourceOwner = { kind: 'managed_host' as const, hostId: 'b', connectionId: 'a-b', endpointIdentity: 'b-endpoint' };
const parentAddress = { coordinator_host_id: 'a', authority_id: 'parent-mcp', resource_epoch: 'epoch' };
function scope(authorityId = 'child-mcp'): ManagedSourceLocalScope {
  return { principal: { principalId: 'a-user', capabilities: ['filesystem:read', 'terminal:use', 'process:control'] },
    coordinatorHostId: 'a', authorityId, resourceEpoch: 'epoch',
    scope: { kind: 'run', runId: `${authorityId}-run`, threadId: `${authorityId}-thread`, epoch: 1 },
    source: { resource_owner: resourceOwner, workspace_id: 'project', execution_workspace_id: authorityId,
      mode: 'materialized', branch_id: `${authorityId}-branch`, revision: 0, live_root: null },
    physicalRoot: { hostId: 'b', rootId: `${authorityId}-root`, canonicalRoot: `/b/materialized/${authorityId}` }, grant: {} as never };
}
const binding: SourceMcpChildBinding = { operationId: 'dispatch', parentRunId: 'parent-mcp-run', executionOwner: { kind: 'kernel' }, executionEpoch: 2 };
const selection: McpBinding = { reference: 'frozen-parent', generation: 7, routes: { public_write: { kind: 'direct' } },
  tools: [{ name: 'public_write', version: 'tool-v1' } as McpBinding['tools'][number]],
  resources: { public_write: 'parent-project', 'server:project': 'parent-project', 'server:deferred': 'parent-deferred' },
  provenance: { servers: Object.fromEntries(['project', 'deferred'].map(name => [name, { definition_version: `definition-${name}`,
    resource_key: `parent-${name}`, owner: { resource_owner: resourceOwner, source_authority: parentAddress,
      configuration: { agent_dir: '/b/agent', config_cwd: '/b/project', project_trusted: true }, execution_scope: 'workspace' as const } }])) } };
const action: Extract<ManagedMcpAction, { kind: 'derive' }> = { kind: 'derive', handleId: 'child-view', creationRequestId: 'child-prepare',
  executionId: 'dispatch', origin: { kind: 'dispatch', parent_source_authority: parentAddress, binding } };
function gate<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function value<T>(reply: ManagedMcpReply): T { if (!reply.ok) throw new Error(reply.error.code); return reply.value as T; }

/** Real service/derivation/retention/composition; controlled native and SDK authority ports. */
function fixture() {
  const child = scope(), parent = scope('parent-mcp');
  const references = new Map<string, SourceMcpChildResult>();
  const receipts = new Map<string, SourceMcpDerivationResult>();
  const tokens = new Set<McpDefinitionLease>();
  const acquired: Array<{ scope: McpAuthorityScope; options: McpAuthorityAcquireOptions; lease: McpAuthorityOwnedLease }> = [];
  const calls: Array<{ authorityId: string; kind: string; name?: string }> = [];
  const native: Array<{ method: string; params: Record<string, unknown> }> = [];
  const watches = new Map<string, () => void>();
  const drains: string[] = [], releases: string[] = [], definitionRetains: string[] = [];
  let observations = 0, parentTokenReleases = 0, trusted = true, withdraw: string | undefined;
  let beginAck: (() => Promise<void>) | undefined, settleAck: (() => Promise<void>) | undefined;
  let acquireHook: ((scope: McpAuthorityScope, options: McpAuthorityAcquireOptions) => Promise<void>) | undefined;
  let closeHook: (() => Promise<void>) | undefined;
  const key = (authorityId: string, operationId: string) => `${authorityId}:${operationId}`;
  const kernel = { async sourceRequest(method: string, raw: Record<string, unknown>) {
    const params = raw as unknown as SourceMcpDerivationParams;
    native.push({ method, params: structuredClone(raw) });
    if (method === 'source.authority.inspect') return { mcpDerivation: [...receipts.entries()].find(([id]) => id.startsWith(`${params.authorityId}:`))?.[1].reference ?? null, mcpChildren: [...references.entries()]
      .filter(([id]) => id.startsWith(`${params.authorityId}:`)).map(([, result]) => result.reference) };
    if (method === 'source.mcp.child') {
      const input = raw as unknown as { authorityId: string; binding: SourceMcpChildBinding; action: string; selection?: McpBinding };
      const id = key(input.authorityId, input.binding.operationId);
      let result = references.get(id);
      if (input.action === 'retain') {
        const created = !result;
        result ??= { reference: { binding: input.binding, released: false, selectionRef: { objectHash: 'selection-object', byteLength: 42 } },
          created, phase: 'ready', grantState: 'active', selection: structuredClone(input.selection!) };
        references.set(id, result); return { ...structuredClone(result), created };
      }
      if (input.action === 'release') {
        result ??= { reference: { binding: input.binding, released: true, selectionRef: null }, created: false,
          phase: 'ready', grantState: 'active', selection: null };
        result.reference.released = true; references.set(id, result);
      }
      if (!result) throw new Error('missing child retention');
      return structuredClone(result);
    }
    if (method !== 'source.mcp.derivation') throw new Error(`Unexpected native request ${method}`);
    const id = key(params.authorityId, params.executionId);
    let result = receipts.get(id);
    if (params.action === 'begin') {
      const created = !result;
      if (!result) {
        const actual = scope(params.authorityId);
        const frozen = params.origin.kind === 'dispatch'
          ? references.get(key(params.origin.parent_source_authority.authority_id, params.origin.binding.operationId))!.selection!
          : params.selection!;
        const proof = { execution_id: params.executionId, child_run_id: `${params.authorityId}-run`, child_thread_id: `${params.authorityId}-thread`,
          source_authority: { coordinator_host_id: params.coordinatorHostId, authority_id: params.authorityId, resource_epoch: params.resourceEpoch },
          source: actual.source, physical_root: actual.physicalRoot, pin: { pin_id: 'original-child-pin' }, handoff: { operation_id: 'original-native-handoff' },
          materialization_operation_id: 'original-materialization', materialization_receipt_hash: 'sha256-native-hash',
          origin: params.origin, selection: structuredClone(frozen) } as unknown as McpChildDerivationProof;
        result = { reference: { executionId: params.executionId, released: false, requestHash: 'original-request-hash',
          requestRef: { objectHash: 'original-proof', byteLength: 500 }, outcomeRef: null }, created, phase: 'ready', grantState: 'active', proof, outcome: null };
        receipts.set(id, result);
      }
      await beginAck?.(); return { ...structuredClone(result), created };
    }
    if (params.action === 'release') {
      result ??= { reference: { executionId: params.executionId, released: true, requestHash: null, requestRef: null, outcomeRef: null },
        created: false, phase: 'ready', grantState: 'active', proof: null, outcome: null };
      result.reference.released = true; receipts.set(id, result); return structuredClone(result);
    }
    if (!result) throw new Error('missing derivation');
    if (params.action === 'settle') {
      if (result.outcome) expect(params.outcome).toEqual(result.outcome);
      result.outcome = structuredClone(params.outcome); result.reference.outcomeRef = { objectHash: 'original-outcome', byteLength: 50 };
      await settleAck?.();
    }
    return structuredClone(result);
  } } as unknown as Pick<KernelClient, 'sourceRequest'>;
  const authority: Pick<McpAuthority, 'acquire' | 'subscribe'> = {
    async subscribe(input, changed) { watches.set(input.sourceAuthority!.authority_id, () => changed({ kind: 'configuration' }));
      return () => { watches.delete(input.sourceAuthority!.authority_id); }; },
    async acquire(input, options) {
      const original = options.deriveFrom?.provenance ?? options.deriveExactCurrent!;
      if (options.deriveFrom) expect(tokens.has(options.deriveFrom)).toBe(true);
      await acquireHook?.(input, options);
      const names = Object.keys(original.servers), authorityId = input.sourceAuthority!.authority_id;
      const provenance = { servers: Object.fromEntries(Object.entries(original.servers).map(([name, server]) => [name,
        { ...structuredClone(server), resource_key: `${authorityId}-${name}`, owner: { ...structuredClone(server.owner), source_authority: input.sourceAuthority! } }])) };
      const tool = (name: string): McpAuthorityTool => ({ name: 'target_write', server: name, tool: 'write', schemaVersion: 'tool-v1',
        resourceKey: provenance.servers[name]!.resource_key, configurationScope: 'project', executionScope: 'workspace',
        inputSchema: { type: 'object' }, taskSupport: 'optional', taskCapable: true, description: '', exposure: 'direct' });
      const servers = names.map(name => ({ name, description: '', resourceKey: provenance.servers[name]!.resource_key,
        hasDirectTools: name === 'project', exposure: name === 'project' ? 'direct' as const : 'deferred' as const,
        configurationScope: 'project' as const, executionScope: 'workspace' as const, status: 'connected' as const,
        cachedToolCount: 1, connectedToolCount: 1, selected: options.servers.includes(name) }));
      const readiness = { configErrorCount: 0, configuredServerCount: names.length, connectedServerCount: options.servers.length,
        cachedToolCount: 1, servers };
      const revoked = new AbortController(); let released = false;
      const check = () => { if (released) throw new Error('mcp-lease-released'); if (withdraw) throw Object.assign(new Error(withdraw), { code: withdraw }); };
      const lease: McpAuthorityOwnedLease = {
        binding: { reference: `${authorityId}-${names.join()}`, generation: 1, provenance, tools: options.servers.map(tool), servers, readiness,
          serverSelections: names.map(name => ({ name, configurationVersion: original.servers[name]!.definition_version, hiddenTools: [] })) },
        implementationIdentity: `${authorityId}-sdk`, inspect: () => readiness,
        async discover(name) { check(); calls.push({ authorityId, kind: 'discover', name }); return [tool(name)]; },
        async prepareTool(name) { check(); return tool(name); },
        async discoverServices(name) { check(); return [{ server: name, resourceKey: provenance.servers[name]!.resource_key, kind: 'resources', schemaVersion: 'service-v1' }]; },
        prepareService: async () => { throw new Error('unused'); }, preparePrompt: async () => { throw new Error('unused'); },
        assertService: check, serviceRevocationSignal: () => { check(); return revoked.signal; }, validateServiceRequest: check,
        async requestService(_service, _request, dispatch) { await dispatch.beforeDispatch?.(); check(); calls.push({ authorityId, kind: 'service' }); return { content: [] } as never; },
        assertCallable: check, revocationSignal: () => { check(); return revoked.signal; }, validateArguments: check,
        async callTool(name, _args, dispatch) { await dispatch.beforeDispatch?.(); check(); calls.push({ authorityId, kind: 'call', name }); return { content: [] }; },
        resourceEndpoint: () => ({ server: names[0]! } as never), observeResource: async () => { throw new Error('unused'); },
        async taskOwner(name) { check(); calls.push({ authorityId, kind: 'task', name }); return { endpoint: { server: name }, release() {} } as never; },
        retainDefinitions(exact) { check(); definitionRetains.push(authorityId);
          return { provenance: structuredClone(exact), release() {} } as McpDefinitionLease; },
        release() { if (released) return; released = true; releases.push(`${authorityId}:${names.join()}`); },
        async releaseAndDrain() { lease.release(); await closeHook?.(); drains.push(`${authorityId}:${names.join()}`); },
      };
      acquired.push({ scope: input, options, lease }); return lease;
    },
  };
  const originalSnapshot = {
    binding: { tools: [], provenance: selection.provenance, readiness: { servers: [] }, servers: [], serverSelections: [] },
    implementationIdentity: 'parent', release() {},
    retainDefinitions(exact: McpBinding['provenance']) {
      const contributions = Object.entries(exact.servers).map(([name, server]) => {
        const token = { provenance: { servers: { [name]: server } }, release() {} } as McpDefinitionLease;
        tokens.add(token); return token;
      });
      return { provenance: exact, contributions, release() { parentTokenReleases++; } };
    },
  } as unknown as McpCompositionSnapshot;
  const create = () => createManagedMcpService({ kernel, authority, hostId: 'b', agentDir: '/b/agent',
    admitSource: async () => {}, admitWorkspaceRegistration: async () => ({ canonicalPath: '/b/project' }), projectTrusted: () => trusted,
    compositions: { async observe() { observations++; return { snapshot: () => originalSnapshot, restore: async () => originalSnapshot,
      release() {}, async releaseAndDrain() {} }; } },
  });
  const service = create();
  const retain = async () => {
    value(await service.request(parent, { kind: 'snapshot', handleId: 'parent-view', creationRequestId: 'parent-create' }));
    value(await service.request(parent, { kind: 'child_retain', handleId: 'parent-view', binding, selection }));
  };
  return { service, create, parent, child, retain, receipts, acquired, calls, native, watches, drains, releases, definitionRetains,
    counts: () => ({ observations, parentTokenReleases }), beginAck: (hook?: typeof beginAck) => { beginAck = hook; },
    settleAck: (hook?: typeof settleAck) => { settleAck = hook; }, acquireHook: (hook?: typeof acquireHook) => { acquireHook = hook; },
    closeHook: (hook?: typeof closeHook) => { closeHook = hook; }, trust: (next: boolean) => { trusted = next; },
    change: (code?: string) => { withdraw = code; watches.get('child-mcp')?.(); } };
}

const derivationCalls = (f: ReturnType<typeof fixture>, action: string) => f.native.filter(call => call.method === 'source.mcp.derivation' && call.params.action === action);

describe('target child MCP derivation', () => {
  it('uses exact retained cuts at the real child cwd and ordinary RPC/task/service/nested-dispatch views', async () => {
    const f = fixture(); await f.retain();
    const prepared = value<ManagedMcpDerivationSnapshot>(await f.service.request(f.child, action));
    expect(f.counts().observations).toBe(1);
    expect(f.acquired.map(item => item.options.servers)).toEqual([['project'], []]);
    for (const acquired of f.acquired) {
      expect(acquired.options.deriveFrom).toBeDefined(); expect(acquired.options.deriveExactCurrent).toBeUndefined();
      expect(acquired.scope).toMatchObject({ executionCwd: '/b/materialized/child-mcp', configCwd: '/b/project',
        sourceAuthority: { authority_id: 'child-mcp' } });
    }
    expect(prepared.receipt.provenance).toEqual(prepared.snapshot.binding.provenance);
    expect(derivationCalls(f, 'settle')[0]?.params.outcome).toEqual({ kind: 'derived', provenance: prepared.receipt.provenance });
    await f.service.request(f.parent, { kind: 'child_release', binding });
    expect(f.counts().parentTokenReleases).toBe(1);
    value(await f.service.request(f.child, { kind: 'call', handleId: action.handleId, name: 'target_write', schemaVersion: 'tool-v1', arguments: {} }));
    const services = value<Parameters<McpAuthorityOwnedLease['assertService']>[0][]>(await f.service.request(f.child,
      { kind: 'discover_services', handleId: action.handleId, server: 'project' }));
    value(await f.service.request(f.child, { kind: 'service', handleId: action.handleId, service: services[0]!, request: { operation: 'resources/list' } }));
    expect(value(await f.service.request(f.child, { kind: 'task_prepare', handleId: action.handleId, server: 'project' }))).toEqual({ server: 'project' });
    const nested = { ...selection, provenance: prepared.receipt.provenance };
    value(await f.service.request(f.child, { kind: 'child_retain', handleId: action.handleId, binding: { ...binding, operationId: 'grandchild' }, selection: nested }));
    expect(f.definitionRetains).toEqual(['child-mcp', 'child-mcp']);
    expect(f.calls.map(call => call.authorityId)).toEqual(['child-mcp', 'child-mcp', 'child-mcp']);
    await f.service.close(); expect(f.drains).toHaveLength(2);
    expect(derivationCalls(f, 'release')).toEqual([]);
  });

  it('joins the original live preparation and cannot reacquire after heap loss or lost native begin ACK', async () => {
    const f = fixture(), ready = gate(); await f.retain(); f.acquireHook(async () => ready.promise);
    const first = f.service.request(f.child, action), joined = f.service.request(f.child, structuredClone(action));
    await vi.waitFor(() => expect(derivationCalls(f, 'begin')).toHaveLength(1)); ready.resolve();
    expect(await joined).toEqual(await first); expect(f.acquired).toHaveLength(2);
    expect(await f.create().request(f.child, action)).toMatchObject({ ok: false, error: { code: 'mcp_child_original_derivation_unavailable' } });
    expect(f.acquired).toHaveLength(2);
    const lost = fixture(); await lost.retain(); lost.beginAck(async () => { throw new Error('begin ACK lost'); });
    expect(await lost.service.request(lost.child, action)).toMatchObject({ ok: false }); lost.beginAck();
    expect(await lost.service.request(lost.child, action)).toMatchObject({ ok: false });
    expect(value(await lost.service.request(lost.child, { kind: 'derivation_inspect', executionId: action.executionId }))).toMatchObject({ live: false, proof: { execution_id: action.executionId } });
    expect(lost.acquired).toEqual([]); expect(derivationCalls(lost, 'begin')).toHaveLength(1);
    await f.service.close(); await lost.service.close();
  });

  it('fences a late child acquisition on exact view cleanup and retains proof after Source retirement', async () => {
    const f = fixture(), ready = gate(); await f.retain(); let entered = 0;
    f.acquireHook(async () => { entered++; await ready.promise; });
    const preparing = f.service.request(f.child, action);
    await vi.waitFor(() => expect(entered).toBe(2));
    let cleaned = false;
    const cleanup = f.service.request(f.child, { kind: 'release', handleId: action.handleId, creationRequestId: action.creationRequestId }).then(reply => { cleaned = true; return reply; });
    await Promise.resolve(); expect(cleaned).toBe(false); ready.resolve();
    expect(await preparing).toMatchObject({ ok: false }); expect(await cleanup).toMatchObject({ ok: true });
    expect(f.drains).toHaveLength(4); // Failed candidate cleanup plus exact explicit drainage are both idempotent owner duties.
    expect(f.releases).toHaveLength(2); expect(f.calls).toEqual([]);
    await f.service.release(f.child);
    expect(derivationCalls(f, 'release')).toEqual([]);
    f.trust(false);
    expect(value(await f.service.request(f.child, { kind: 'derivation_inspect', executionId: action.executionId }))).toMatchObject({ live: false, outcome: { kind: 'failed' } });
    expect(value(await f.service.request(f.child, { kind: 'derivation_release', executionId: action.executionId }))).toEqual({ released: true });
    await f.service.close();
  });

  it('retries only original outcome persistence and releases the receipt independently of a live view', async () => {
    const f = fixture(); await f.retain(); let failed = false;
    f.settleAck(async () => { if (!failed) { failed = true; throw new Error('settle ACK lost'); } });
    expect(await f.service.request(f.child, action)).toMatchObject({ ok: false });
    expect(value(await f.service.request(f.child, { kind: 'derivation_inspect', executionId: action.executionId }))).toMatchObject({ live: true, outcome: { kind: 'derived' } });
    value(await f.service.request(f.child, action)); expect(f.acquired).toHaveLength(2); expect(derivationCalls(f, 'begin')).toHaveLength(1);
    expect(derivationCalls(f, 'settle')).toHaveLength(2);
    value(await f.service.request(f.child, { kind: 'derivation_release', executionId: action.executionId }));
    expect(value(await f.service.request(f.child, { kind: 'derivation_inspect', executionId: action.executionId })))
      .toMatchObject({ live: true, reference: { released: true }, prepared: { snapshot: { binding: { tools: [{ name: 'target_write' }] } } } });
    value(await f.service.request(f.child, { kind: 'call', handleId: action.handleId, name: 'target_write', schemaVersion: 'tool-v1', arguments: {} }));
    expect(f.drains).toEqual([]); await f.service.close();
  });

  it('restores the same settled Source root after a post-commit projection is released', async () => {
    const f = fixture(); await f.retain(); const original = value<ManagedMcpDerivationSnapshot>(await f.service.request(f.child, action));
    value(await f.service.request(f.child, { kind: 'derivation_release', executionId: action.executionId }));
    value(await f.service.request(f.child, { kind: 'release', handleId: action.handleId, creationRequestId: action.creationRequestId }));
    expect(f.drains).toEqual([]); expect(f.releases).toEqual([]);
    expect(await f.service.request(f.child, { kind: 'call', handleId: action.handleId, name: 'target_write', schemaVersion: 'tool-v1', arguments: {} })).toMatchObject({ ok: false });
    const restored = value<{ live: boolean; prepared: ManagedMcpDerivationSnapshot }>(await f.service.request(f.child,
      { kind: 'derivation_inspect', executionId: action.executionId }));
    expect(restored.live).toBe(true); expect(restored.prepared.snapshot).toEqual(original.snapshot);
    value(await f.service.request(f.child, { kind: 'call', handleId: action.handleId, name: 'target_write', schemaVersion: 'tool-v1', arguments: {} }));
    expect(f.acquired).toHaveLength(2); expect(f.counts().observations).toBe(1);
    const restarted = f.create();
    expect(await restarted.request(f.child, { kind: 'snapshot', handleId: 'random', creationRequestId: 'random', selection }))
      .toMatchObject({ ok: false, error: { code: 'mcp_child_original_derivation_unavailable' } });
    expect(f.counts().observations).toBe(1);
    await f.service.release(f.child); expect(f.drains).toHaveLength(2);
    expect(value(await f.service.request(f.child, { kind: 'derivation_inspect', executionId: action.executionId }))).toMatchObject({ live: false });
    await f.service.close();
  });

  it('uses exact-current definitions only for an explicit native-proved continuation', async () => {
    const f = fixture();
    const continuation = { ...action, executionId: 'continuation', origin: { kind: 'continuation' as const, previous_run_id: 'previous-run' }, selection };
    value(await f.service.request(f.child, continuation));
    expect(f.counts().observations).toBe(0); expect(f.acquired).toHaveLength(1);
    expect(f.acquired[0]!.options).toMatchObject({ deriveExactCurrent: selection.provenance, servers: ['project'] });
    expect(f.acquired[0]!.options.deriveFrom).toBeUndefined(); await f.service.close();
  });

  it('wakes the original derived view for explicit withdrawal without poisoning it after malformed config', async () => {
    const f = fixture(); await f.retain(); const prepared = value<ManagedMcpDerivationSnapshot>(await f.service.request(f.child, action));
    const changed = (after: number) => f.service.request(f.child, { kind: 'changed', incarnation: prepared.snapshot.incarnation, after });
    const malformed = changed(0); f.change('mcp-config-invalid');
    const first = value<{ revision: number; revocations: Record<string, unknown> }>(await malformed);
    expect(first.revocations[action.handleId]).toEqual({ tools: [], services: [] });
    const withdrawn = changed(first.revision); f.change('mcp-tool-revoked');
    expect(value<{ revocations: Record<string, unknown> }>(await withdrawn).revocations[action.handleId])
      .toEqual({ tools: [{ name: 'target_write', schemaVersion: 'tool-v1' }], services: [] });
    expect(f.acquired).toHaveLength(2); await f.service.close(); expect(f.watches.has('child-mcp')).toBe(false);
  });

  it('remembers withdrawal while a settled child projection is detached', async () => {
    const f = fixture(); await f.retain(); value(await f.service.request(f.child, action));
    value(await f.service.request(f.child, { kind: 'release', handleId: action.handleId, creationRequestId: action.creationRequestId }));
    f.change('mcp-tool-revoked'); f.change();
    expect(value(await f.service.request(f.child, { kind: 'derivation_inspect', executionId: action.executionId })))
      .toMatchObject({ live: true, prepared: { snapshot: { revocations: { tools: [{ name: 'target_write', schemaVersion: 'tool-v1' }] } } } });
    expect(await f.service.request(f.child, { kind: 'call', handleId: action.handleId, name: 'target_write', schemaVersion: 'tool-v1', arguments: {} }))
      .toMatchObject({ ok: false, error: { code: 'mcp_tool_revoked' } });
    expect(f.acquired).toHaveLength(2); expect(f.calls).toEqual([]); await f.service.close();
  });

  it('keeps root revocations when outcome acknowledgement is lost before the first snapshot is returned', async () => {
    const f = fixture(); await f.retain(); let failed = false;
    f.settleAck(async () => { if (!failed) { failed = true; throw new Error('outcome ACK lost'); } });
    expect(await f.service.request(f.child, action)).toMatchObject({ ok: false });
    f.change('mcp-tool-revoked'); f.change();
    expect(value(await f.service.request(f.child, { kind: 'derivation_inspect', executionId: action.executionId })))
      .toMatchObject({ live: true, prepared: { snapshot: { revocations: { tools: [{ name: 'target_write', schemaVersion: 'tool-v1' }] } } } });
    expect(f.acquired).toHaveLength(2); await f.service.close();
  });

  it('awaits all original acquisitions even when a sibling fails, and retains a failed drain for retry', async () => {
    const f = fixture(), ready = gate(); await f.retain(); let entered = 0, finished = false;
    f.acquireHook(async (_scope, options) => { entered++; if (options.servers.length) throw new Error('direct unavailable'); await ready.promise; });
    f.closeHook(async () => { throw new Error('actual close failed'); });
    const preparing = f.service.request(f.child, action).then(result => { finished = true; return result; });
    await vi.waitFor(() => expect(entered).toBe(2)); await Promise.resolve(); expect(finished).toBe(false);
    ready.resolve(); expect(await preparing).toMatchObject({ ok: false }); expect(f.acquired).toHaveLength(1);
    expect(await f.service.request(f.child, { kind: 'release', handleId: action.handleId, creationRequestId: action.creationRequestId })).toMatchObject({ ok: false });
    f.closeHook();
    expect(await f.service.request(f.child, { kind: 'release', handleId: action.handleId, creationRequestId: action.creationRequestId })).toMatchObject({ ok: true });
    expect(f.drains).toHaveLength(1); await f.service.release(f.child);
    expect(derivationCalls(f, 'release')).toEqual([]); await f.service.close();
  });
});
