import { expect, it, vi } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import { HostBindingRestoreError } from '@varin/extension-host';
import { leafHostComposition } from './host-composition.test-helper.js';
import { AgentRuntimeClient, type McpPreparation } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type {
  ExtensionToolLease,
  ExtensionToolPreparer,
} from './extension-tool-owner.js';
import type { McpToolLease } from './tool-bridge.js';
import type { ExistingHostCredentialOwner } from './credential-owner.js';
import type {
  LiveExtensionToolBinding, LiveMcpBinding, DelegatedExecution,
  LaunchIntent,
  Run,
  RunContextScope,
} from './protocol.generated.js';
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise<void>((r) => setImmediate(r));
// This transport double supplies only the child facts consumed by preparation.
type ChildExecutionResponse = Pick<DelegatedExecution,
  'execution_id' | 'child_operation_id' | 'parent_run_id' | 'selected_profile' | 'launch'
> & { trigger: Pick<DelegatedExecution['trigger'], 'kind'> };
function contribution(
  service: string,
  version: string,
  released: string[],
): ExtensionToolLease {
  const revoked = new AbortController(),
    schema = {
      name: service,
      version,
      description: `${service} ${version}`,
      schema: { type: 'object' },
      output_schema: { type: 'object' },
      metadata: {
        service_id: service,
        service_version: 1,
        completion: 'result' as const,
        operation: 'read' as const,
      },
    };
  const providerKey = `extension-${service}-${version}:host:${service}@1`,
    binding = {
      providerKey,
      extensionId: `extension-${service}-${version}`,
      extensionVersion: version,
      serviceId: service,
      serviceVersion: 1,
      artifactIntegrity: `artifact-${service}-${version}`,
      composition: leafHostComposition({ extensionId: `extension-${service}-${version}`, extensionVersion: version, artifactIntegrity: `artifact-${service}-${version}` }),
      declarationHash: version,
      configurationIdentity: null,
      tool: schema,
    };
  return {
    binding,
    generation: 1,
    revocationSignal: revoked.signal,
    lease: {
      slot: `extension:${service}@1`,
      binding: {
        reference: providerKey,
        generation: 1,
        resources: {},
        tools: [schema],
      },
      implementationIdentity: providerKey,
      available: () => !revoked.signal.aborted,
      revocationSignal: () => revoked.signal,
      authorize: async () => {},
      execute: async () => ({
        completion: {
          kind: 'result',
          outcome: 'succeeded',
          effect: 'confirmed',
          content: { data: {}, parts: [] },
        },
        executor_stopped: true,
      }),
      release: () => released.push(`${service}:${version}`),
    },
  };
}
function setup(initial: ExtensionToolLease[] = [], failRegistration = 0, withExtensionOwner = true) {
  const run: Run = {
    id: 'run',
    thread_id: 'thread',
    branch_id: 'branch',
    state: 'accepted',
    revision: 1,
    epoch: 1,
    configuration: {},
    cancel_requested: false,
    waiting_on: null,
  };
  const launch: LaunchIntent = { driver_preparable: false, policy_preparable: false, policy_generation: 0, policy_target: { kind: 'default' },
    run_id: 'run',
    revision: 1,
    startable: true,
    pause: null,
    preparation_failure: null,
    requires_rebind: false,
    bound_epoch: 1,
    selection: {
      extension_bindings: [],
      mcp_binding: null,
      child_dispatch: null, driver: { kind: 'builtin', name: 'varin.default', version: '1' }, driver_models: [], policy_models: [],
      credential_scope: null,
      connection_identity: 'fixture',
      provider_family: 'fixture',
      model: 'fixture',
      configuration_generation: 1,
      tool_schema_generation: 1,
      tools: [
        {
          name: 'native',
          version: '1',
          description: 'Native fixture',
          schema: {},
          output_schema: null,
          metadata: null,
        },
      ],
      source: null,
      policy: {
        name: 'default+questions+collaboration+process-wait',
        version: '1',
      },
    },
  };
  let publish!: (
      key: string,
      lease: ExtensionToolLease | undefined,
      revoked?: ExtensionToolLease,
    ) => Promise<void>,
    releaseRun!: (run: string) => void,
    registrations = 0;
  const requests: Array<{ method: string; params: Record<string, unknown> }> =
      [],
    ready: Array<Record<string, unknown>> = [],
    leases = new Map<string, ExtensionToolLease>();
  let startGate: Promise<void> | undefined,
    gate: Promise<void> | undefined,
    failReady = false,
    failReadyNumber: number | undefined,
    mcp: LiveMcpBinding | undefined;
  let admittedScope: RunContextScope | null = null;
  let child: ChildExecutionResponse | null = null;
  let currentProject: string | null = null;
  const preparedScopes: Array<Parameters<ExtensionToolPreparer>[0]> = [];
  const preparedBindings: Array<Parameters<ExtensionToolPreparer>[1]> = [];
  const closeScope = vi.fn();
  let preparationFailure: Error | undefined;
  const preparer: ExtensionToolPreparer = async (input, required) => {
    preparedScopes.push(input);
    preparedBindings.push(structuredClone(required));
    if (preparationFailure) throw preparationFailure;
    return {
      initial,
      start(callback) {
        publish = callback;
      },
      inspect: () => [],
      close: closeScope,
    };
  };
  const kernel = {
    isReady: true,
    issueGrant: async () => ({ grantId: 'source-grant' }),
    revokeGrant: async () => ({}),
    scoped: () => ({
      // Fixed source admission precedes any mutable execution view.
      executionViewInspect: async () => null,
      readBranch: async () => ({
        workspaceId: 'workspace',
        branchId: 'source',
        view: 'revision',
        revision: 7,
        root: 'fixture-root',
      }),
    }),
    subscribeExit: () => () => {},
    onToolReleased: (callback: typeof releaseRun) => {
      releaseRun = callback;
      return () => {};
    },
    beginRunPreparation: () => ({
      signal: new AbortController().signal,
      release() {},
    }),
    policyBinding: () => undefined,
    driverBinding: () => undefined,
    mcpBinding: () => mcp?.binding,
    mcpLiveBinding: () => mcp,
    mcpImplementationIdentity: () => undefined,
    registerCredentialOwner: async () => ({}),
    unregisterCredentialOwner() {},
    releaseRunPolicyOwners() {}, releaseRunDriverOwner() {}, isRunDriverInvoking() { return false; },
    cancelRunPreparation() {},
    releaseChildToolHandoff: vi.fn(),
    unregisterToolOwners() {},
    registerExtensionTool: async (
      _run: string,
      lease: ExtensionToolLease,
    ): Promise<LiveExtensionToolBinding> => {
      registrations++;
      if (registrations === failRegistration)
        throw new Error('registration failed');
      const ownerId = `owner-${registrations}`;
      leases.set(ownerId, lease);
      return { ownerId, generation: lease.generation, binding: lease.binding };
    },
    discardExtensionTool: (_run: string, live: LiveExtensionToolBinding) => {
      leases.get(live.ownerId)?.lease.release();
      leases.delete(live.ownerId);
    },
    retainedExtensionBinding: (_run: string, binding: LiveExtensionToolBinding['binding']) => {
      const original = [...leases].find(([, retained]) => isDeepStrictEqual(retained.binding, binding));
      return original ? { ownerId: original[0], generation: original[1].generation, binding } : undefined;
    },
    registerMcpOwner: async (_run: string, lease: McpToolLease) => {
      mcp = { ownerId: 'initial-mcp', binding: lease.binding };
      return lease.binding;
    },
    registerMcpCandidate: async (_run: string, lease: McpToolLease) => ({
      ownerId: 'updated-mcp',
      binding: lease.binding,
    }),
    discardMcpCandidate() {},
    toolAvailability: () => true,
    agentRuntimeRequest: async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      requests.push({ method, params: structuredClone(params) });
      switch (method) {
        case 'runtime.run.inspect':
          return structuredClone(run);
        case 'runtime.launch.inspect':
          return structuredClone(launch);
        case 'runtime.run.scope':
          return structuredClone(admittedScope);
        case 'runtime.model.inspect':
          return { active: null, desired: null };
        case 'runtime.child.execution.for_run':
          return child;
        case 'runtime.context.inspect':
          return currentProject
            ? { personalization: { projectId: currentProject } }
            : null;
        case 'runtime.run.reconcile':
        case 'runtime.memory.reconcile':
        case 'runtime.plan.reconcile':
          return {};
        case 'runtime.launch.mcp.prepare':
          launch.selection.mcp_binding =
            params.binding as LaunchIntent['selection']['mcp_binding'];
          return structuredClone(launch);
        case 'runtime.launch.extensions.prepare':
          launch.selection.extension_bindings =
            params.bindings as LaunchIntent['selection']['extension_bindings'];
          if (launch.extension_admission) launch.extension_admission.state = 'prepared';
          return structuredClone(launch);
        case 'runtime.run.start':
          if (startGate) await startGate;
          run.state = 'executing';
          return { runId: 'run', epoch: 1 };
        case 'runtime.tools.select':
          return {};
        case 'runtime.tools.ready': {
          ready.push(structuredClone(params));
          if (gate) await gate;
          if (failReady || ready.length === failReadyNumber) {
            failReady = false;
            failReadyNumber = undefined;
            throw new Error('candidate rejected');
          }
          const extensions =
            params.extensionBindings as LiveExtensionToolBinding[];
          launch.selection.extension_bindings = extensions.map(
            (e) => e.binding,
          );
          launch.selection.tools = [
            launch.selection.tools[0]!,
            ...extensions.map((e) => e.binding.tool),
          ];
          launch.selection.tool_schema_generation++;
          return { ready: true };
        }
        default:
          throw new Error(`unexpected method ${method}`);
      }
    },
  } as unknown as KernelClient;
  const mcpLeases: McpToolLease[] = [];
  const mcpInputs: McpPreparation[] = [];
  const runtime = new AgentRuntimeClient(
    kernel,
    async input => { mcpInputs.push(structuredClone(input)); return mcpLeases.shift(); },
    undefined,
    undefined,
    undefined,
    withExtensionOwner ? preparer : undefined,
    async (id, signal) => {
      signal?.throwIfAborted();
      expect(['workspace', 'execution']).toContain(id);
    },
  );
  return {
    runtime,
    launch,
    releaseChildHandoff: kernel.releaseChildToolHandoff,
    preparedScopes,
    preparedBindings, closeScope,
    loseExtensionOwners: () => { leases.clear(); run.state = 'runnable'; },
    prepareExtensions: (next: ExtensionToolLease[], failure?: Error) => { initial = next; preparationFailure = failure; },
    child: (value: ChildExecutionResponse) => { child = value; },
    admittedScope: (scope: RunContextScope | null) => {
      admittedScope = scope;
    },
    currentProject: (project: string) => {
      currentProject = project;
    },
    requests,
    ready,
    mcpLeases, mcpInputs, resetMcp: () => { mcp = undefined; },
    publish: (
      key: string,
      lease: ExtensionToolLease | undefined,
      revoked?: ExtensionToolLease,
    ) => publish(key, lease, revoked),
    startGate: (value: Promise<void>) => {
      startGate = value;
    },
    gate: (value: Promise<void> | undefined) => {
      gate = value;
    },
    failReadyAt: (number: number) => {
      failReadyNumber = number;
    },
    failReady: () => {
      failReady = true;
    },
    release: () => {
      run.state = 'completed';
      releaseRun('run');
    },
  };
}
it.each([false, true])('same-Run continuation restores an unavailable exact extension owner without manual retry (credentials: %s)', async credentials => {
  const released: string[] = [], original = contribution('chosen', '1', released), f = setup([original]);
  const start = () => credentials
    ? f.runtime.startRunWithCredentialOwner('run', {} as ExistingHostCredentialOwner)
    : f.runtime.startRun('run');
  await start();
  const first = f.requests.find(request => request.method === 'runtime.run.start')!.params;
  f.loseExtensionOwners();
  const restored = contribution('chosen', '1', released);
  restored.generation++;
  restored.lease.binding.generation++;
  f.prepareExtensions([restored]);
  await start();
  const starts = f.requests.filter(request => request.method === 'runtime.run.start');
  expect(starts).toHaveLength(2);
  expect(f.preparedBindings).toEqual([[], [original.binding]]);
  expect(f.closeScope).toHaveBeenCalledOnce();
  expect(starts[1]!.params).toMatchObject({ runId: 'run', extensionBindings: [{ binding: original.binding, generation: 2 }] });
  expect((starts[1]!.params.extensionBindings as LiveExtensionToolBinding[])[0]!.ownerId)
    .not.toBe((first.extensionBindings as LiveExtensionToolBinding[])[0]!.ownerId);
  // A later continuation can reuse the repaired owner without another cold preparation.
  await start();
  expect(f.preparedBindings).toHaveLength(2);
});

it('an unavailable exact implementation remains a preparation failure instead of replacing or omitting its tool', async () => {
  const original = contribution('chosen', '1', []), f = setup([original]);
  await f.runtime.startRun('run');
  f.loseExtensionOwners();
  const failure = new HostBindingRestoreError('tool', 'implementation_unavailable', original.binding.providerKey);
  f.prepareExtensions([], failure);
  await expect(f.runtime.startRun('run')).rejects.toBe(failure);
  expect(f.preparedBindings).toEqual([[], [original.binding]]);
  expect(f.requests.filter(request => request.method === 'runtime.run.start')).toHaveLength(1);
  expect(f.launch.selection.extension_bindings).toEqual([original.binding]);
  f.prepareExtensions([contribution('chosen', '1', [])]);
  await f.runtime.startRun('run');
  expect(f.preparedBindings).toEqual([[], [original.binding], [original.binding]]);
});

it.each(['dispatch', 'user_continuation'] as const)('%s binds only its admitted services and derives MCP once before exact same-Run restore', async trigger => {
  const released: string[] = [], extension = contribution('chosen', '1', released), f = setup([extension]);
  const base = contribution('mcp_read', '1', released).lease;
  const original: McpToolLease = { ...base, slot: 'mcp', binding: { ...base.binding, routes: Object.fromEntries(base.binding.tools.map(tool => [tool.name,{kind:'direct' as const}])),
    provenance: { servers: {} } } };
  f.launch.selection.extension_bindings = [extension.binding];
  f.launch.selection.mcp_binding = original.binding;
  f.child({ execution_id: trigger === 'dispatch' ? 'parent-dispatch' : 'next-execution', child_operation_id: 'parent-dispatch',
    parent_run_id: 'parent-run', trigger: { kind: trigger },
    selected_profile: { preset_id: null, catalog_identity: null, work_mode: 'read_only', tools: [], instructions: '' } satisfies DelegatedExecution['selected_profile'],
    launch: structuredClone(f.launch.selection) }); // Catalog fences are tested by their owner.
  const derived: McpToolLease = { ...original, binding: { ...original.binding, reference: 'child-execution-owner' } };
  f.mcpLeases.push(derived);
  await f.runtime.prepareMcp('run', null);
  expect(f.mcpInputs[0]).toMatchObject({ runId: 'run', threadId: 'thread', fixed: true, delegatedBinding: original.binding });
  expect(f.launch.selection.mcp_binding).toEqual(derived.binding);
  f.resetMcp(); f.mcpLeases.push(derived);
  await f.runtime.prepareMcp('run', null);
  expect(f.mcpInputs[1]).toMatchObject({ requiredBinding: derived.binding, fixed: true });
  expect(f.mcpInputs[1]).not.toHaveProperty('delegatedBinding');
  const started = deferred<void>(); f.startGate(started.promise);
  const starting = f.runtime.startRun('run');
  await expect.poll(() => f.requests.some(request => request.method === 'runtime.run.start')).toBe(true);
  expect(f.releaseChildHandoff).not.toHaveBeenCalled();
  started.resolve(); await starting;
  if (trigger === 'dispatch') expect(f.releaseChildHandoff).toHaveBeenCalledExactlyOnceWith('parent-run', 'parent-dispatch');
  else expect(f.releaseChildHandoff).not.toHaveBeenCalled();
  expect(f.requests.filter(request => request.method === 'runtime.child.execution.for_run').every(request => (request.params as { runId: string }).runId === 'run')).toBe(true);
  expect(f.preparedScopes).toEqual([{ runId: 'run', threadId: 'thread', branchId: 'branch', source: null, fixed: true, workFocus: 'general' }]);
  const start = f.requests.find(request => request.method === 'runtime.run.start')!;
  expect((start.params.extensionBindings as LiveExtensionToolBinding[]).map(value => value.binding)).toEqual([extension.binding]);
  await f.publish('unselected@1', contribution('unselected', '1', released));
  expect(f.ready).toEqual([]);
  expect(released).toContain('unselected:1');
});
it('first Run starts without slow contributions; concurrent ready completions and MCP refresh merge through one short publication chain', async () => {
  const released: string[] = [],
    a = deferred<ExtensionToolLease>(),
    b = deferred<ExtensionToolLease>(),
    f = setup();
  const mcp = (name: string): McpToolLease => ({
    ...contribution(name, '1', released).lease,
    slot: 'mcp',
    binding: { ...contribution(name, '1', released).lease.binding, routes: { [name]: {kind:'direct'} }, provenance: { servers: {} } },
  });
  f.mcpLeases.push(mcp('mcp_initial'));
  await f.runtime.prepareMcp('run', null);
  await f.runtime.startRun('run');
  expect(
    f.requests.find((r) => r.method === 'runtime.run.start')?.params
      .extensionBindings,
  ).toBeUndefined();
  const pendingA = a.promise.then((lease) => f.publish('A@1', lease)),
    pendingB = b.promise.then((lease) => f.publish('B@1', lease));
  const publication = deferred<void>();
  f.gate(publication.promise);
  a.resolve(contribution('A', 'v1', released));
  await tick();
  expect(f.ready).toHaveLength(1);
  expect(
    (f.ready[0]!.extensionBindings as LiveExtensionToolBinding[]).map(
      (e) => e.binding.serviceId,
    ),
  ).toEqual(['A']);
  b.resolve(contribution('B', 'v1', released));
  f.mcpLeases.push(mcp('mcp_next'));
  const refresh = f.runtime.refreshMcp('run');
  await tick();
  expect(f.ready).toHaveLength(1);
  expect(
    f.requests.filter((r) => r.method === 'runtime.tools.select'),
  ).toHaveLength(1);
  f.gate(undefined);
  publication.resolve();
  await Promise.all([pendingA, pendingB, refresh]);
  expect(f.ready).toHaveLength(2);
  const final = f.ready.at(-1)!;
  expect(
    (final.extensionBindings as LiveExtensionToolBinding[]).map(
      (e) => e.binding.serviceId,
    ),
  ).toEqual(['A', 'B']);
  expect((final.binding as LiveMcpBinding).binding.tools[0]!.name).toBe(
    'mcp_next',
  );
  expect(
    (await f.runtime.inspectTools('run')).callable.map((t) => t.name),
  ).toEqual(['native', 'A', 'B']);
});
it('a failed replacement preserves the previous ready owner, and completion cannot publish or revive a late contribution', async () => {
  const released: string[] = [],
    f = setup();
  await f.runtime.startRun('run');
  await f.publish('A@1', contribution('A', 'v1', released));
  const candidate = contribution('A', 'v2', released);
  f.failReady();
  await expect(f.publish('A@1', candidate)).rejects.toThrow(
    'candidate rejected',
  );
  expect(released).toContain('A:v2');
  expect(released).not.toContain('A:v1');
  const beforeRevocation = f.ready.length;
  await f.publish('A@1', undefined, candidate);
  expect(f.ready).toHaveLength(beforeRevocation);
  await f.publish('B@1', contribution('B', 'v1', released));
  expect(
    (f.ready.at(-1)!.extensionBindings as LiveExtensionToolBinding[]).find(
      (e) => e.binding.serviceId === 'A',
    )?.binding.tool.version,
  ).toBe('v1');
  f.release();
  const before = f.ready.length;
  await f.publish('C@1', contribution('C', 'v1', released));
  expect(f.ready).toHaveLength(before);
  expect(released).toContain('C:v1');
  expect((await f.runtime.inspectTools('run')).callable).toEqual([]);
});
it('multi-contribution startup registration failure releases transferred and still-untransferred exact pins once', async () => {
  const released: string[] = [],
    f = setup(
      ['A', 'B', 'C'].map((name) => contribution(name, 'v1', released)),
      2,
    );
  await expect(f.runtime.startRun('run')).rejects.toThrow(
    'registration failed',
  );
  expect(released.sort()).toEqual(['A:v1', 'B:v1', 'C:v1']);
  expect(f.requests.some((r) => r.method === 'runtime.run.start')).toBe(false);
});

it('an accepted A snapshot is not rolled back when the following concurrent B snapshot is rejected', async () => {
  const released: string[] = [],
    f = setup(),
    gate = deferred<void>();
  await f.runtime.startRun('run');
  f.gate(gate.promise);
  const first = f.publish('A@1', contribution('A', 'v1', released));
  await tick();
  const second = f.publish('B@1', contribution('B', 'v1', released));
  const failed = expect(second).rejects.toThrow('candidate rejected');
  f.failReadyAt(2);
  f.gate(undefined);
  gate.resolve();
  await first;
  await failed;
  expect(released).not.toContain('A:v1');
  expect(released).toContain('B:v1');
  expect(f.ready).toHaveLength(3);
  expect(
    (f.ready.at(-1)!.extensionBindings as LiveExtensionToolBinding[]).map(
      (e) => e.binding.serviceId,
    ),
  ).toEqual(['A']);
  expect(
    (await f.runtime.inspectTools('run')).callable.map((t) => t.name),
  ).toEqual(['native', 'A']);
  await f.publish('C@1', contribution('C', 'v1', released));
  expect(
    (f.ready.at(-1)!.extensionBindings as LiveExtensionToolBinding[]).map(
      (e) => e.binding.serviceId,
    ),
  ).toEqual(['A', 'C']);
});
it('cold contribution publication waits for the start ACK without delaying start, and receives the real rejected-ready outcome', async () => {
  const released: string[] = [],
    f = setup(),
    startGate = deferred<void>(),
    readyGate = deferred<void>();
  f.startGate(startGate.promise);
  const starting = f.runtime.startRun('run');
  await expect
    .poll(() =>
      f.requests.some((request) => request.method === 'runtime.run.start'),
    )
    .toBe(true);
  let completed = false;
  const contributionReady = f.publish('A@1', contribution('A', 'v1', released));
  void contributionReady.then(
    () => {
      completed = true;
    },
    () => {
      completed = true;
    },
  );
  const failed =
    expect(contributionReady).rejects.toThrow('candidate rejected');
  await tick();
  expect(completed).toBe(false);
  expect(f.ready).toEqual([]);
  f.gate(readyGate.promise);
  f.failReady();
  startGate.resolve();
  await starting; // Start's own ACK does not await this service's pending publication.
  expect(completed).toBe(false);
  expect(f.ready).toHaveLength(1);
  f.gate(undefined);
  readyGate.resolve();
  await failed;
  expect(released).toEqual(['A:v1']);
  expect(
    f.ready.at(-1)!.extensionBindings as LiveExtensionToolBinding[],
  ).toEqual([]);
  expect(
    (await f.runtime.inspectTools('run')).callable.map((tool) => tool.name),
  ).toEqual(['native']);
});
it('a failed start releases a cold contribution that is still waiting for its start acknowledgement', async () => {
  const released: string[] = [],
    f = setup(),
    startGate = deferred<void>();
  f.startGate(startGate.promise);
  const starting = f.runtime.startRun('run');
  const startFailure = expect(starting).rejects.toThrow('start failed');
  await expect
    .poll(() =>
      f.requests.some((request) => request.method === 'runtime.run.start'),
    )
    .toBe(true);
  const publishing = f.publish('A@1', contribution('A', 'v1', released));
  const publicationFailure = expect(publishing).rejects.toThrow();
  await tick();
  expect(f.ready).toEqual([]);
  startGate.reject(new Error('start failed'));
  await startFailure;
  await publicationFailure;
  expect(released).toEqual(['A:v1']);
  expect(f.ready).toEqual([]);
});

it('source start, saved rebind and successor continuation preserve ordinary and MCP tools outside the native source whitelist', async () => {
  for (const entry of ['start', 'rebind', 'continue'] as const) {
    const released: string[] = [],
      extension = contribution('extension_read', 'v1', released),
      f = setup([extension]);
    const mcp: McpToolLease = {
      ...contribution('mcp_read', 'v1', released).lease,
      slot: 'mcp',
      binding: { ...contribution('mcp_read', 'v1', released).lease.binding, routes: {mcp_read:{kind:'direct'}}, provenance: { servers: {} } },
    };
    f.mcpLeases.push(mcp);
    f.launch.selection.source = {
      resource_owner: { kind: 'local' as const },
      workspace_id: 'workspace',
      execution_workspace_id: 'execution',
      mode: 'fixed_branch',
      branch_id: 'source',
      revision: 7,
      live_root: null,
    };
    f.launch.selection.extension_bindings = [extension.binding];
    f.launch.selection.mcp_binding = mcp.binding;
    f.launch.selection.tools = [
      { ...f.launch.selection.tools[0]!, name: 'file_read', requirements: { source: 'source', process: false } },
      { ...f.launch.selection.tools[0]!, name: 'ask_user' },
      { ...f.launch.selection.tools[0]!, name: 'question_status' },
      { ...f.launch.selection.tools[0]!, name: 'goal_report' },
      mcp.binding.tools[0]!,
      extension.binding.tool,
    ];
    if (entry === 'start')
      await f.runtime.startFromSource({
        runId: 'run',
        resourceOwner: { kind: 'local' as const },
        workspaceId: 'workspace',
        executionWorkspaceId: 'execution',
        mode: 'fixed_branch',
        branchId: 'source',
        revision: 7,
        tools: ['file_read'],
      });
    else if (entry === 'rebind') await f.runtime.rebindLaunch('run');
    else await f.runtime.continueFromLaunch('previous', 'run');
    expect(f.preparedScopes[0]?.source).toEqual(f.launch.selection.source);
    const start = f.requests.find(
      (request) => request.method === 'runtime.run.start',
    )!.params;
    expect(start.toolBinding).toMatchObject({
      enabledTools: ['file_read'],
      fileSource: { branchId: 'source', revision: 7 },
    });
    expect(
      (start.extensionBindings as LiveExtensionToolBinding[]).map(
        (binding) => binding.binding,
      ),
    ).toEqual([extension.binding]);
    expect((start.mcpBinding as LiveMcpBinding).binding).toEqual(
      mcp.binding,
    );
  }
});

it('ordinary service routing uses the admitted Run scope instead of a later active branch checkpoint', async () => {
  for (const projectId of [null, 'admitted-project']) {
    const f = setup();
    f.launch.selection.agent = { profileId: 'researcher', name: 'Researcher', workFocus: 'research', tools: null };
    f.currentProject('later-project');
    f.admittedScope(
      projectId
        ? { mode: 'agent', threadRole: 'main', threadId: 'thread', projectId }
        : null,
    );
    await f.runtime.startRun('run');
    expect(f.preparedScopes).toEqual([
      { runId: 'run', threadId: 'thread', branchId: 'branch', source: null, workFocus: 'research', ...(projectId ? { projectId } : {}) },
    ]);
    expect(
      f.requests
        .filter((request) => request.method === 'runtime.run.scope')
        .map((request) => request.params),
    ).toEqual([{ runId: 'run' }]);
    expect(
      f.requests.some(
        (request) => request.method === 'runtime.context.inspect',
      ),
    ).toBe(false);
  }
});

it.each([false, true])('automatic root prepares the complete current directory once, then restores it exactly (credentials: %s)', async credentials => {
  const old = contribution('previous', 'old', []), current = contribution('newly-enabled', 'current', []), f = setup([current]);
  f.launch.selection.extension_bindings = [old.binding];
  f.launch.extension_admission = { state: 'pending' };
  const start = () => credentials
    ? f.runtime.startRunWithCredentialOwner('run', {} as ExistingHostCredentialOwner)
    : f.runtime.startRun('run');
  await start();
  expect(f.preparedBindings).toEqual([[]]);
  expect(f.preparedScopes[0]!.restoreExact).toBeUndefined();
  const prepareIndex = f.requests.findIndex(request => request.method === 'runtime.launch.extensions.prepare');
  expect(f.requests[prepareIndex]!.params.bindings).toEqual([current.binding]);
  expect(prepareIndex).toBeLessThan(f.requests.findIndex(request => request.method === 'runtime.run.start'));
  expect(f.launch.extension_admission).toEqual({ state: 'prepared' });
  f.loseExtensionOwners();
  await start();
  expect(f.preparedBindings).toEqual([[], [current.binding]]);
  expect(f.preparedScopes[1]!.restoreExact).toBe(true);
  const added = contribution('added', 'current', []);
  await f.publish('added@1', added);
  f.prepareExtensions([current, added]); f.loseExtensionOwners();
  await start();
  expect(f.preparedBindings[2]).toEqual([added.binding, current.binding]);
});

it('pending admission discards a prior empty scope and commits the newly enabled current directory', async () => {
  const f = setup();
  await f.runtime.startRun('run');
  const current = contribution('newly-enabled', 'current', []);
  f.prepareExtensions([current]);
  f.launch.extension_admission = { state: 'pending' };
  await f.runtime.startRun('run');
  expect(f.closeScope).toHaveBeenCalledOnce();
  expect(f.preparedBindings).toEqual([[], []]);
  expect(f.preparedScopes[1]!.restoreExact).toBeUndefined();
  expect(f.requests.filter(request => request.method === 'runtime.launch.extensions.prepare').map(request => request.params.bindings)).toEqual([[current.binding]]);
});

it.each([false, true])('an automatic empty current directory commits before start, with or without an extension owner (%s)', async withOwner => {
  const f = setup([], 0, withOwner);
  f.launch.extension_admission = { state: 'pending' };
  await f.runtime.startRun('run');
  const commit = f.requests.findIndex(request => request.method === 'runtime.launch.extensions.prepare');
  expect(f.requests[commit]!.params.bindings).toEqual([]);
  expect(commit).toBeLessThan(f.requests.findIndex(request => request.method === 'runtime.run.start'));
  // A reconstructed Host must request explicit empty restoration, not fresh discovery.
  if (withOwner) f.release();
  const restored = setup([], 0, withOwner);
  restored.launch.extension_admission = { state: 'prepared' };
  await restored.runtime.startRun('run');
  expect(restored.preparedScopes.map(value => value.restoreExact)).toEqual(withOwner ? [true] : []);
  expect(restored.requests.some(request => request.method === 'runtime.launch.extensions.prepare')).toBe(false);
});

it.each(['pending', 'prepared'] as const)('a nonempty %s directory cannot silently disappear without its Host owner', async state => {
  const f = setup([], 0, false);
  f.launch.extension_admission = { state };
  f.launch.selection.extension_bindings = [contribution('previous', 'old', []).binding];
  await expect(f.runtime.startRun('run')).rejects.toThrow('Saved extension tools require their original Host owner');
  expect(f.requests.some(request => request.method === 'runtime.launch.extensions.prepare' || request.method === 'runtime.run.start')).toBe(false);
});

it('automatic current-snapshot preparation failure does not commit or start the Run', async () => {
  const old = contribution('previous', 'old', []), f = setup();
  f.launch.selection.extension_bindings = [old.binding];
  f.launch.extension_admission = { state: 'pending' };
  f.prepareExtensions([], new Error('current settings snapshot unavailable'));
  await expect(f.runtime.startRun('run')).rejects.toThrow('current settings snapshot unavailable');
  expect(f.preparedBindings).toEqual([[]]);
  expect(f.launch.selection.extension_bindings).toEqual([old.binding]);
  expect(f.requests.some(request => request.method === 'runtime.launch.extensions.prepare' || request.method === 'runtime.run.start')).toBe(false);
});
