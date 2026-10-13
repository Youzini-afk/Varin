import { describe, expect, it } from 'vitest';
import type { McpCompositionSnapshot } from '@varin/pi-host/mcp-authority';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { McpBinding, SourceMcpChildBinding, SourceMcpChildParams, SourceMcpChildResult } from '../kernel/protocol.generated.js';
import { createManagedMcpChildren } from './managed-mcp-children.js';
import type { ManagedMcpChildAction } from './managed-mcp-contract.js';

const scope = { principal: { principalId: 'a-principal', capabilities: [] }, coordinatorHostId: 'a', authorityId: 'original-source', resourceEpoch: 'b-kernel' };
const binding: SourceMcpChildBinding = { operationId: 'dispatch', parentRunId: 'parent-run', executionOwner: { kind: 'kernel' }, executionEpoch: 3 };
const selection: McpBinding = { reference: 'a-logical-reference', generation: 11, routes: {}, resources: {}, tools: [], provenance: { servers: {
  first: { definition_version: 'original-first', resource_key: 'first-resource', owner: { resource_owner: { kind: 'managed_host', hostId: 'b', connectionId: 'a-to-b', endpointIdentity: 'b-endpoint' },
    configuration: { agent_dir: '/agent', config_cwd: '/original', project_trusted: true }, execution_scope: 'workspace',
    source_authority: { coordinator_host_id: 'a', authority_id: 'original-source', resource_epoch: 'b-kernel' } } },
  second: { definition_version: 'original-second', resource_key: 'second-resource', owner: { resource_owner: { kind: 'managed_host', hostId: 'b', connectionId: 'a-to-b', endpointIdentity: 'b-endpoint' },
    configuration: { agent_dir: '/agent', config_cwd: '/original', project_trusted: true }, execution_scope: 'workspace',
    source_authority: { coordinator_host_id: 'a', authority_id: 'original-source', resource_epoch: 'b-kernel' } } },
} } };
const action: Extract<ManagedMcpChildAction, { kind: 'child_retain' }> = { kind: 'child_retain', handleId: 'original-view', binding, selection };
const signal = () => new AbortController().signal;
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
/** Controlled native port. This does not substitute for Storage's native state-machine tests. */
function fixture() {
  let reference: SourceMcpChildResult['reference'] | undefined, body: McpBinding | null = null;
  let phase: SourceMcpChildResult['phase'] = 'ready', grantState: SourceMcpChildResult['grantState'] = 'active';
  let acquisitions = 0, releases = 0, views = 0, retains = 0, reads = 0, sealed = false;
  let retainHook: (() => Promise<void>) | undefined, replyHook: (() => Promise<void>) | undefined;
  let releaseHook: (() => Promise<void>) | undefined, viewHook: (() => Promise<void>) | undefined, authorityHook: (() => Promise<void>) | undefined;
  const calls: Array<{ method: string; params: unknown; signal: AbortSignal | undefined }> = [];
  const result = (created = false, read = false): SourceMcpChildResult => ({ reference: structuredClone(reference!), created, phase, grantState,
    selection: read && !reference!.released ? structuredClone(body) : null });
  const kernel = { async sourceRequest(method: string, params: SourceMcpChildParams, active?: AbortSignal) {
    calls.push({ method, params: structuredClone(params), signal: active });
    expect(params.principalId).toBe(scope.principal.principalId); expect(params.authorityId).toBe(scope.authorityId);
    if (method === 'source.authority.inspect') { await authorityHook?.(); return { mcpChildren: reference ? [structuredClone(reference)] : [] }; }
    expect(method).toBe('source.mcp.child');
    if (reference && JSON.stringify(reference.binding) !== JSON.stringify(params.binding)) throw new Error('native binding changed');
    if (params.action === 'retain') {
      retains++; await retainHook?.();
      if (reference?.released) return result();
      if (sealed) throw new Error('native source sealed');
      const created = !reference;
      if (body && JSON.stringify(body) !== JSON.stringify(params.selection)) throw new Error('native selection changed');
      body = structuredClone(params.selection);
      reference ??= { binding: structuredClone(params.binding), selectionRef: { objectHash: 'sha256-native-object-unrelated-to-a-reference', byteLength: 901 }, released: false };
      await replyHook?.(); return result(created);
    }
    if (params.action === 'release') {
      await releaseHook?.();
      reference ??= { binding: structuredClone(params.binding), selectionRef: null, released: true };
      reference.released = true;
      if (phase === 'retaining') phase = 'draining';
      return result();
    }
    if (!reference) throw new Error('native reference absent');
    if (params.action === 'read') reads++;
    return result(false, params.action === 'read');
  } } as Pick<KernelClient, 'sourceRequest'>;
  const view = async (_scope: unknown, handleId: string, active: AbortSignal) => {
    views++; expect(handleId).toBe(action.handleId); await viewHook?.(); active.throwIfAborted();
    if (sealed) throw new Error('view sealed');
    return { beforeDispatch: async () => { active.throwIfAborted(); if (sealed) throw new Error('view sealed'); }, lease: {
      retainDefinitions(exact: McpBinding['provenance']) {
        expect(exact).toEqual(selection.provenance); acquisitions++;
        const contributions = Object.keys(exact.servers).map(name => ({ provenance: { servers: { [name]: exact.servers[name]! } }, release() {} }));
        return { provenance: structuredClone(exact), contributions, release() { releases++; } };
      },
    } as unknown as McpCompositionSnapshot };
  };
  const create = () => createManagedMcpChildren({ kernel, view });
  return { children: create(), create, calls, counts: () => ({ acquisitions, releases, views, retains, reads }),
    authorityHook: (next?: typeof authorityHook) => { authorityHook = next; }, reference: () => reference, body: () => body, phase: (next: typeof phase) => { phase = next; }, revoke: () => { grantState = 'revoked'; },
    seal: () => { sealed = true; }, retainHook: (next?: typeof retainHook) => { retainHook = next; },
    replyHook: (next?: typeof replyHook) => { replyHook = next; }, releaseHook: (next?: typeof releaseHook) => { releaseHook = next; }, viewHook: (next?: typeof viewHook) => { viewHook = next; } };
}

describe('original managed MCP child definitions', () => {
  it('reserves one exact dependency cut before native ACK and rejects changed bindings/selections', async () => {
    const f = fixture(), gate = deferred(); f.retainHook(() => gate.promise);
    const first = f.children.retain(scope, action, signal()), duplicate = f.children.retain(scope, structuredClone(action), signal());
    await expect(f.children.retain(scope, { ...action, binding: { ...binding, executionEpoch: 4 } }, signal())).rejects.toThrow('binding_changed');
    await expect(f.children.retain(scope, { ...action, selection: { ...selection, generation: 12 } }, signal())).rejects.toThrow('selection_changed');
    while (!f.counts().retains) await Promise.resolve();
    expect(f.counts()).toMatchObject({ acquisitions: 1, views: 1, retains: 1, releases: 0 });
    gate.resolve(); expect(await first).toMatchObject({ live: true }); expect(await duplicate).toMatchObject({ live: true });
    const inspection = await f.children.inspect(scope, binding);
    expect(inspection).not.toHaveProperty('selection'); expect(inspection.reference.selectionRef?.objectHash).not.toBe(selection.reference);
    await f.children.withRetainedDefinitions(scope, binding, async original => {
      expect(original.contributions).toHaveLength(2); expect(original.selection).toEqual(selection);
      expect(Object.isFrozen(original.selection.provenance.servers)).toBe(true);
    });
    f.phase('retaining'); f.seal();
    expect(await f.children.inspect(scope, binding)).toMatchObject({ live: true, phase: 'retaining' });
    expect(await f.children.release(scope, binding)).toEqual({ retire: true, dependenciesDrained: true });
    expect(f.counts().releases).toBe(1);
  });

  it('isolates caller cancellation from original late ACK and dependency cleanup', async () => {
    const f = fixture(), gate = deferred(), caller = new AbortController(); f.replyHook(() => gate.promise);
    const first = f.children.retain(scope, action, caller.signal);
    while (!f.reference()) await Promise.resolve();
    caller.abort(new Error('caller left'));
    await expect(first).rejects.toThrow('caller left'); expect(f.counts().releases).toBe(0);
    let inspected = false;
    const inspecting = f.children.inspect(scope, binding).then(result => { inspected = true; return result; });
    await Promise.resolve(); expect(inspected).toBe(false);
    gate.resolve(); expect(await inspecting).toMatchObject({ live: true });
    expect(f.calls.find(call => (call.params as SourceMcpChildParams).action === 'retain')?.signal).toBeUndefined();
    await f.children.release(scope, binding); expect(f.counts().releases).toBe(1);
  });

  it('preserves an ACK-lost original token for cleanup without claiming cross-heap ownership', async () => {
    const f = fixture(); let failed = false;
    f.replyHook(async () => { if (!failed) { failed = true; throw new Error('native ACK lost'); } });
    await expect(f.children.retain(scope, action, signal())).rejects.toThrow('ACK lost');
    expect(f.counts()).toMatchObject({ acquisitions: 1, releases: 0 });
    expect(await f.children.inspect(scope, binding)).toMatchObject({ live: false, reference: { released: false } });
    await expect(f.children.withRetainedDefinitions(scope, binding, async () => 'never')).rejects.toThrow('original_definitions_unavailable');
    expect(f.counts()).toMatchObject({ acquisitions: 1, releases: 0, views: 1, retains: 2 });
    await f.children.release(scope, binding); expect(f.counts().releases).toBe(1);
  });

  it('retries an unpersisted selection using its existing token, without a new view', async () => {
    const f = fixture(); let failed = false;
    f.retainHook(async () => { if (!failed) { failed = true; throw new Error('native write failed'); } });
    await expect(f.children.retain(scope, action, signal())).rejects.toThrow('write failed');
    expect(f.reference()).toBeUndefined(); expect(f.counts().releases).toBe(0);
    expect(await f.children.inspect(scope, binding)).toMatchObject({ live: true });
    expect(await f.children.withRetainedDefinitions(scope, binding, async original => original.contributions.length)).toBe(2);
    expect(f.counts()).toMatchObject({ acquisitions: 1, views: 1, retains: 2 });
    await f.children.close(scope); expect(f.counts().releases).toBe(1);
  });

  it('reads existing durable references after restart without reconstructing a dependency cut', async () => {
    const f = fixture(); await f.children.retain(scope, action, signal());
    const reopened = f.create();
    expect(await reopened.inspect(scope, binding)).toMatchObject({ live: false });
    expect(await reopened.retain(scope, action, signal())).toMatchObject({ live: false });
    expect(f.counts()).toMatchObject({ acquisitions: 1, views: 1, reads: 1 });
    await expect(f.create().retain(scope, { ...action, selection: { ...selection, reference: 'different' } }, signal())).rejects.toThrow('selection_changed');
    await expect(reopened.withRetainedDefinitions(scope, binding, async () => 'never')).rejects.toThrow('original_definitions_unavailable');
    await reopened.release(scope, binding); await f.children.close(scope);
  });

  it('discards a newly captured candidate when another heap wins first native insertion', async () => {
    const f = fixture(), gate = deferred(); f.retainHook(() => gate.promise);
    const other = f.create();
    const first = f.children.retain(scope, action, signal()), second = other.retain(scope, action, signal());
    while (f.counts().retains !== 2) await Promise.resolve();
    gate.resolve();
    const results = await Promise.all([first, second]);
    expect(results.filter(result => result.live)).toHaveLength(1);
    expect(f.counts()).toMatchObject({ acquisitions: 2, releases: 1 });
    await Promise.all([f.children.close(scope), other.close(scope)]); expect(f.counts().releases).toBe(2);
  });

  it('persists release before retain and joins late retention ACK before releasing the original token', async () => {
    const empty = fixture(), releaseGate = deferred(); empty.releaseHook(() => releaseGate.promise);
    const releaseFirst = empty.children.release(scope, binding);
    await expect(empty.children.retain(scope, action, signal())).rejects.toThrow('reference_released');
    expect(empty.counts().acquisitions).toBe(0); releaseGate.resolve(); await releaseFirst;
    expect(await empty.create().retain(scope, action, signal())).toMatchObject({ live: false, reference: { released: true } });
    expect(empty.counts().acquisitions).toBe(0);

    const f = fixture(), gate = deferred(); f.replyHook(() => gate.promise);
    const retaining = f.children.retain(scope, action, signal());
    while (!f.reference()) await Promise.resolve();
    let drained = false;
    const releasing = f.children.release(scope, binding).then(result => { drained = true; return result; });
    while (!f.reference()?.released) await Promise.resolve();
    expect(drained).toBe(false); expect(f.counts().releases).toBe(0);
    gate.resolve(); expect(await retaining).toMatchObject({ live: false }); await releasing;
    expect(f.counts().releases).toBe(1);
  });

  it('pins exact callback use through cleanup and caller cancellation until the callback actually settles', async () => {
    const f = fixture(); await f.children.retain(scope, action, signal());
    const gate = deferred(), entered = deferred(), caller = new AbortController(); let active!: AbortSignal;
    const using = f.children.withRetainedDefinitions(scope, binding, async original => {
      active = original.signal; entered.resolve(); await gate.promise; return original.contributions.length;
    }, caller.signal);
    await entered.promise; caller.abort(new Error('caller left'));
    await expect(using).rejects.toThrow('caller left');
    let drained = false;
    const releasing = f.children.release(scope, binding).then(() => { drained = true; });
    while (!f.reference()?.released) await Promise.resolve();
    expect(active.aborted).toBe(true); expect(drained).toBe(false); expect(f.counts().releases).toBe(0);
    gate.resolve(); await releasing; expect(f.counts().releases).toBe(1);
  });

  it('explicit close fences admissions, joins pending work, and exposes failed durable cleanup', async () => {
    const f = fixture(), gate = deferred(); f.replyHook(() => gate.promise);
    const retaining = f.children.retain(scope, action, signal());
    while (!f.reference()) await Promise.resolve();
    f.releaseHook(async () => { throw new Error('release write failed'); });
    let finished = false;
    const closing = f.children.close(scope).finally(() => { finished = true; });
    await expect(f.children.retain(scope, { ...action, binding: { ...binding, operationId: 'late' } }, signal())).rejects.toThrow('reference_released');
    await Promise.resolve(); expect(finished).toBe(false); expect(f.counts().releases).toBe(0);
    gate.resolve(); expect(await retaining).toMatchObject({ live: false });
    await expect(closing).rejects.toThrow('release write failed');
    expect(f.counts().releases).toBe(1); expect(f.reference()?.released).toBe(false);
    f.releaseHook(); await f.children.close(scope); expect(f.reference()?.released).toBe(true); expect(f.counts().releases).toBe(1);
  });

  it('does not interpret an unavailable authority preflight as a missing reference', async () => {
    const f = fixture(); f.authorityHook(async () => { throw new Error('authority unavailable'); });
    await expect(f.children.retain(scope, action, signal())).rejects.toThrow('authority unavailable');
    expect(f.counts()).toMatchObject({ views: 0, acquisitions: 0, retains: 0 });
    await f.children.close(scope);
  });

  it('captures caller input before awaiting the original view', async () => {
    const f = fixture(), gate = deferred(), mutable = structuredClone(action); f.viewHook(() => gate.promise);
    const retaining = f.children.retain(scope, mutable, signal());
    while (!f.counts().views) await Promise.resolve();
    mutable.handleId = 'replacement-view'; mutable.binding.operationId = 'replacement-dispatch';
    mutable.selection.reference = 'replacement-reference'; mutable.selection.provenance.servers.first!.definition_version = 'replacement-definition';
    gate.resolve(); expect(await retaining).toMatchObject({ live: true, reference: { binding } });
    expect(f.body()).toEqual(selection); await f.children.close(scope);
  });

  it('joins a delayed view on close without admitting a late definition token', async () => {
    const f = fixture(), gate = deferred(); f.viewHook(() => gate.promise);
    const retaining = f.children.retain(scope, action, signal());
    while (!f.counts().views) await Promise.resolve();
    let closed = false;
    const closing = f.children.close(scope).then(() => { closed = true; });
    while (!f.reference()?.released) await Promise.resolve();
    expect(closed).toBe(false); gate.resolve();
    await expect(retaining).rejects.toThrow(); await closing;
    expect(f.counts()).toMatchObject({ acquisitions: 0, retains: 0, releases: 0 });
  });

  it('keeps original token when ordinary release loses its ACK, and never exposes revoked ownership', async () => {
    const f = fixture(); await f.children.retain(scope, action, signal());
    f.releaseHook(async () => { throw new Error('release unavailable'); });
    await expect(f.children.release(scope, binding)).rejects.toThrow('release unavailable');
    expect(f.counts().releases).toBe(0); f.revoke();
    expect(await f.children.inspect(scope, binding)).toMatchObject({ live: false, grantState: 'revoked' });
    await expect(f.children.withRetainedDefinitions(scope, binding, async () => 'never')).rejects.toThrow('original_definitions_unavailable');
    f.releaseHook(); await f.children.close(scope); expect(f.counts().releases).toBe(1);
  });
});
