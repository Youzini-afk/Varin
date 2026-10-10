import { expect, it } from 'vitest';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type {
  ExtensionToolLease,
  ExtensionToolPreparer,
} from './extension-tool-owner.js';
import type { HostToolLease, LiveHostToolBinding } from './tool-bridge.js';
import type {
  LiveExtensionToolBinding,
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
          content: {},
        },
        executor_stopped: true,
      }),
      release: () => released.push(`${service}:${version}`),
    },
  };
}
function setup(initial: ExtensionToolLease[] = [], failRegistration = 0) {
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
  const launch: LaunchIntent = { policy_preparable: false, policy_generation: 0, policy_target: { kind: 'default' },
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
      child_dispatch: null, policy_models: [],
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
    mcp: LiveHostToolBinding | undefined;
  let admittedScope: RunContextScope | null = null;
  let currentProject: string | null = null;
  const preparedScopes: Array<Parameters<ExtensionToolPreparer>[0]> = [];
  const preparer: ExtensionToolPreparer = async (input) => {
    preparedScopes.push(input);
    return {
      initial,
      start(callback) {
        publish = callback;
      },
      inspect: () => [],
      close() {},
    };
  };
  const kernel = {
    isReady: true,
    issueGrant: async () => ({ grantId: 'source-grant' }),
    revokeGrant: async () => ({}),
    scoped: () => ({
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
    mcpBinding: () => mcp?.binding,
    mcpLiveBinding: () => mcp,
    mcpImplementationIdentity: () => undefined,
    unregisterCredentialOwner() {},
    releaseRunPolicyOwners() {},
    cancelRunPreparation() {},
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
    registerMcpOwner: async (_run: string, lease: HostToolLease) => {
      mcp = { ownerId: 'initial-mcp', binding: lease.binding };
      return lease.binding;
    },
    registerMcpCandidate: async (_run: string, lease: HostToolLease) => ({
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
        case 'runtime.child.for_thread':
          return null;
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
  const mcpLeases: HostToolLease[] = [];
  const runtime = new AgentRuntimeClient(
    kernel,
    async () => mcpLeases.shift(),
    undefined,
    undefined,
    undefined,
    preparer,
  );
  return {
    runtime,
    launch,
    preparedScopes,
    admittedScope: (scope: RunContextScope | null) => {
      admittedScope = scope;
    },
    currentProject: (project: string) => {
      currentProject = project;
    },
    requests,
    ready,
    mcpLeases,
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
it('first Run starts without slow contributions; concurrent ready completions and MCP refresh merge through one short publication chain', async () => {
  const released: string[] = [],
    a = deferred<ExtensionToolLease>(),
    b = deferred<ExtensionToolLease>(),
    f = setup();
  const mcp = (name: string): HostToolLease => ({
    ...contribution(name, '1', released).lease,
    slot: 'mcp',
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
  expect((final.binding as LiveHostToolBinding).binding.tools[0]!.name).toBe(
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
    const mcp = {
      ...contribution('mcp_read', 'v1', released).lease,
      slot: 'mcp',
    };
    f.mcpLeases.push(mcp);
    f.launch.selection.source = {
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
      { ...f.launch.selection.tools[0]!, name: 'file_read' },
      { ...f.launch.selection.tools[0]!, name: 'ask_user' },
      { ...f.launch.selection.tools[0]!, name: 'question_status' },
      { ...f.launch.selection.tools[0]!, name: 'goal_report' },
      mcp.binding.tools[0]!,
      extension.binding.tool,
    ];
    if (entry === 'start')
      await f.runtime.startFromSource({
        runId: 'run',
        workspaceId: 'workspace',
        executionWorkspaceId: 'execution',
        mode: 'fixed_branch',
        branchId: 'source',
        revision: 7,
        tools: ['file_read'],
      });
    else if (entry === 'rebind') await f.runtime.rebindLaunch('run');
    else await f.runtime.continueFromLaunch('previous', 'run');
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
    expect((start.mcpBinding as LiveHostToolBinding).binding).toEqual(
      mcp.binding,
    );
  }
});

it('ordinary service routing uses the admitted Run scope instead of a later active branch checkpoint', async () => {
  for (const projectId of [null, 'admitted-project']) {
    const f = setup();
    f.currentProject('later-project');
    f.admittedScope(
      projectId
        ? { mode: 'agent', threadRole: 'main', sessionId: 'thread', projectId }
        : null,
    );
    await f.runtime.startRun('run');
    expect(f.preparedScopes).toEqual([
      { runId: 'run', threadId: 'thread', ...(projectId ? { projectId } : {}) },
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
