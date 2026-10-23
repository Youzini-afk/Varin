import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { COMPUTER_CAPABILITY, COMPUTER_TOOL_DECLARATIONS, VARIN_BUILTIN_COMPUTER_EXTENSION_ID } from '@varin/extension-builtins';
import { parseVarinExtensionManifest } from '@varin/extension-contract';
import { createMaterialStoreFixture } from '../harness/web-materials.test-helper.js';
import {
  createMaterialToolOwner,
  MATERIAL_SNAPSHOT_CAPABILITY,
} from './material-tool-owner.js';
import {
  createExtensionTools,
  retainExtensionTool,
} from './extension-tool-owner.js';
import {
  ToolBridge,
  type HostToolCall,
  type PrivateToolFrame,
} from './tool-bridge.js';
import type { KernelClient } from './kernel-client.js';
import { createComputerRuntime } from './computer-runtime.js';
import { createNestedToolOwner, VARIN_RUNTIME_TOOLS_CAPABILITY } from './nested-tool-owner.js';

it('installed SDK declaration reaches shared bridge, compiled schemas, validated model/policy scope and real material adapter', async () => {
  const repository = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../..',
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-tool-core-'));
  let runtime: ApplicationExtensionRuntime | undefined;
  try {
    const example = path.join(root, 'example');
    await fs.mkdir(example);
    const source = path.join(
      repository,
      'examples/extensions/material-snapshot-tool',
    );
    for (const file of ['package.json', 'varin.extension.json'])
      await fs.copyFile(path.join(source, file), path.join(example, file));
    const manifest = parseVarinExtensionManifest(
        JSON.parse(
          await fs.readFile(path.join(example, 'varin.extension.json'), 'utf8'),
        ),
      ),
      descriptor = manifest.provides!.services![0]!;
    const { build } = createRequire(
      path.join(repository, 'packages/extension-builtins/package.json'),
    )('esbuild');
    await build({
      entryPoints: [path.join(source, 'host.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: path.join(example, 'host.cjs'),
      alias: {
        '@varin/extension-sdk': path.join(
          repository,
          'packages/extension-sdk/dist/index.js',
        ),
      },
    });
    const opened = createMaterialStoreFixture();
    const snapshot = await opened.materials.put(
      'ws',
      {
        sourceUrl: 'https://example.com/stored',
        finalUrl: 'https://example.com/stored',
        representation: 'raw-text',
      },
      Buffer.from('Aé🙂中B'),
      {
        owningWorkspaceId: 'ws',
        kind: 'thread',
        threadId: 'thread',
      },
    );
    runtime = await ApplicationExtensionRuntime.create({
      dataDir: path.join(root, 'extensions'),
      varinVersion: '0.9.25',
      brokerScript: path.join(
        repository,
        'packages/extension-host/broker/broker-child.mjs',
      ),
    });
    runtime.capabilities.register(
      MATERIAL_SNAPSHOT_CAPABILITY,
      createMaterialToolOwner(opened.materials, async invocation => ({ kind: "thread", owningWorkspaceId: "ws", threadId: invocation.threadId })),
    );
    await runtime.start();
    await runtime.installOrStage({
      source: {
        kind: 'local',
        display: 'Material example',
        specifier: example,
      },
      expectedRevision: (await runtime.catalog.snapshot()).revision,
    });
    await runtime.reviewCapabilities({
      extensionId: manifest.id,
      expectedRevision: (await runtime.catalog.snapshot()).revision,
      decisions: [
        {
          capability: MATERIAL_SNAPSHOT_CAPABILITY,
          realm: 'host',
          granted: true,
        },
      ],
    });
    await runtime.setEnabled(
      manifest.id,
      true,
      (await runtime.catalog.snapshot()).revision,
    );
    const selected = await runtime.prepareService({
      serviceId: descriptor.id,
      version: descriptor.version,
      method: 'execute',
      args: [],
      routing: { threadId: 'thread' },
    });
    let invocation: HostToolCall | undefined;
    let tampered = false;
    // Explicit management-query fixture: production owner/bridge/SDK/domain run here, not real kernel IPC.
    const kernel = {
      agentRuntimeRequest: async (method: string) => {
        if (method === 'runtime.operation.inspect')
          return {
            id: invocation!.operationId,
            run_id: 'run',
            phase: 'running',
            cancel_requested: false,
            execution_owner: executionOwner,
            intent: {
              origin: tampered
                ? { kind: 'model_step', request_id: 'forged' }
                : invocation!.origin,
              call: {
                call_id: invocation!.callId,
                name: invocation!.name,
                schema_version: invocation!.schemaVersion,
                arguments: invocation!.arguments,
              },
            },
          };
        if (method === 'runtime.run.inspect')
          return { id: 'run', thread_id: 'thread', cancel_requested: false };
        if (method === 'runtime.launch.inspect')
          return {
            run_id: 'run',
            selection: {
              source: {
                workspace_id: 'ws',
                execution_workspace_id: 'unrelated-execution',
                mode: 'fixed_branch',
                branch_id: 'branch',
                revision: 1,
                live_root: null,
              },
            },
          };
        throw new Error(`unexpected query ${method}`);
      },
    } as unknown as KernelClient;
    const options = {
      runtime,
      kernel,
      configurationIdentity: Object.assign(() => null, { enabled: (value: { id: string }) => value.id === descriptor.id }),
      currentPolicy: async () => ({
        mode: 'normal' as const,
        rules: [{ tool: descriptor.tool!.name, decision: 'allow' as const }],
      }),
    };
    const retained = await retainExtensionTool(options, selected);
    expect(retained.binding.tool).toMatchObject({
      description: descriptor.tool!.description,
      schema: descriptor.tool!.inputSchema,
      output_schema: descriptor.tool!.outputSchema,
    });
    const frames: PrivateToolFrame[] = [];
    const bridge = new ToolBridge(
      () => 'epoch',
      async (frame) => {
        frames.push(frame);
        if (frame.kind === 'host-tool-receipt')
          queueMicrotask(() =>
            bridge.consume({
              v: 1,
              kind: 'host-tool-receipt-ack',
              kernelEpoch: 'epoch',
              id: frame.id,
              accepted: true,
            }),
          );
      },
      () => {
        throw new Error('transport failed');
      },
    );
    const live = bridge.register('run', retained.lease);
    const executionOwner = {
      kind: 'external',
      identity: retained.binding.providerKey,
      epoch: live.ownerId,
    };
    bridge.consume({
      v: 1,
      kind: 'host-tool-binding-retain',
      kernelEpoch: 'epoch',
      runId: 'run',
      ownerId: live.ownerId,
      holderId: 'holder',
    });
    for (const policy of [false, true]) {
      const id = policy ? 'policy' : 'model',
        origin = policy
          ? {
              kind: 'policy_action' as const,
              action_id: 'action',
              node_id: 'node',
            }
          : { kind: 'model_step' as const, request_id: 'request' };
      invocation = {
        runId: 'run',
        operationId: policy ? 'action:node:node' : 'request:tool:call',
        origin,
        callId: policy ? 'node' : 'call',
        name: descriptor.tool!.name,
        schemaVersion: retained.binding.tool.version,
        arguments: {
          snapshotId: snapshot.snapshotId,
          offset: 0,
          maxBytes: 4,
          expectedContentHash: snapshot.contentHash,
        },
      };
      const send = (phase: string) =>
        bridge.consume({
          v: 1,
          kind: 'host-tool-request',
          id: `${id}:${phase}`,
          kernelEpoch: 'epoch',
          phase,
          binding: {
            ownerId: live.ownerId,
            reference: retained.binding.providerKey,
            generation: retained.generation,
            holderId: 'holder',
          },
          call: invocation,
        });
      send('authorize');
      await expect
        .poll(() =>
          frames.find(
            (f) =>
              f.kind === 'host-tool-response' && f.id === `${id}:authorize`,
          ),
        )
        .toMatchObject({ ok: true });
      send('execute');
      await expect
        .poll(() =>
          frames.find(
            (f) => f.kind === 'host-tool-response' && f.id === `${id}:execute`,
          ),
        )
        .toMatchObject({
          executor_stopped: true,
          completion: {
            kind: 'result',
            outcome: 'succeeded',
            content: { data: { text: 'Aé', nextOffset: 3 }, parts: [] },
          },
        });
    }
    const bad = {
      ...invocation!,
      operationId: 'request:tool:bad',
      origin: { kind: 'model_step' as const, request_id: 'request' },
      callId: 'bad',
      arguments: { snapshotId: snapshot.snapshotId, offset: -1, maxBytes: 4 },
    };
    await expect(
      retained.lease.authorize(bad, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'extension_tool_input_schema_invalid', message: expect.stringContaining('/offset') });
    bridge.consume({
      v: 1, kind: 'host-tool-request', id: 'bad:authorize', kernelEpoch: 'epoch', phase: 'authorize',
      binding: { ownerId: live.ownerId, reference: retained.binding.providerKey, generation: retained.generation, holderId: 'holder' },
      call: { ...bad, arguments: { snapshotId: snapshot.snapshotId, offset: 0, maxBytes: 4, unexpected: 'PRIVATE_ARGUMENT_VALUE' } },
    });
    await expect.poll(() => frames.find(f => f.kind === 'host-tool-response' && f.id === 'bad:authorize'))
      .toMatchObject({ ok: false, error: { admission: true, code: 'extension_tool_input_schema_invalid',
        message: expect.stringContaining('unexpected') } });
    expect(JSON.stringify(frames.find(f => f.kind === 'host-tool-response' && f.id === 'bad:authorize')))
      .not.toContain('PRIVATE_ARGUMENT_VALUE');
    invocation = {
      ...bad,
      operationId: 'request:tool:tampered',
      callId: 'tampered',
      arguments: { snapshotId: snapshot.snapshotId, offset: 0, maxBytes: 4 },
    };
    tampered = true;
    await retained.lease.authorize(invocation, new AbortController().signal);
    expect(
      await retained.lease.execute(
        invocation,
        new AbortController().signal,
        executionOwner as { kind: 'external'; identity: string; epoch: string },
      ),
    ).toMatchObject({ completion: { kind: 'not_dispatched' } });
   const scope = await createExtensionTools(options)(
      { runId: 'second', threadId: 'thread', branchId: 'history-branch', source: null },
      [],
      new AbortController().signal,
    );
    expect(scope.initial).toHaveLength(1);
    expect(scope.inspect()[0]?.status).toBe('ready');
    scope.close();
    for (const initial of scope.initial) initial.lease.release();
    // An already active Computer provider is inspected before the Run's explicit
    // tool selection. Its broken configuration must not hide an independent tool.
    runtime.capabilities.register(COMPUTER_CAPABILITY, async () => null);
    await runtime.activateExtension(VARIN_BUILTIN_COMPUTER_EXTENSION_ID);
    const computer = createComputerRuntime({ kernel, runtime: {} as never, enabled: async () => true,
      computers: { automation: { attachRequests: () => {} },
        applicationToolAvailability: async () => ({ browser: true, office: true }),
        defaultDesktop: async () => { throw new Error('malformed original Computer default'); } } as never });
    const isolated = await createExtensionTools({ ...options, prepareConfiguration: computer.prepareConfiguration })(
      { runId: 'independent-custom-selection', threadId: 'thread', branchId: 'history-branch', source: null }, [], new AbortController().signal,
    );
    try {
      expect(isolated.initial.map(value => value.binding.serviceId)).toContain(descriptor.id);
      expect(isolated.initial.some(value => COMPUTER_TOOL_DECLARATIONS.some(declaration => declaration.id === value.binding.serviceId))).toBe(false);
      for (const declaration of COMPUTER_TOOL_DECLARATIONS) expect(isolated.inspect()).toContainEqual(expect.objectContaining({
        serviceId: declaration.id, status: 'unavailable', error: `extension_tool_configuration_unavailable:${declaration.id}`,
      }));
      // Exact saved bindings remain mandatory even though optional candidates isolate failure.
      await expect(createExtensionTools({ ...options, configurationIdentity: () => { throw new Error('required configuration unavailable'); } })(
        { runId: 'required', threadId: 'thread', branchId: 'history-branch', source: null }, [retained.binding], new AbortController().signal,
      )).rejects.toThrow(`extension_tool_configuration_unavailable:${descriptor.id}`);
    } finally { isolated.close(); for (const initial of isolated.initial) initial.lease.release(); }
    bridge.close();
    await expect(
      retainExtensionTool(options, await runtime.prepareService({ serviceId: descriptor.id, version: descriptor.version, method: 'execute', args: [], routing: { threadId: 'thread' } }), {
        ...retained.binding,
        artifactIntegrity: 'different-original-artifact',
      }),
    ).rejects.toThrow('exact_binding_unavailable');
  } finally {
    try {
      await runtime?.stop();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}, 20_000);

it('real A-to-B routing keeps A on rejected B publication, ignores disabled B, and preserves invalid output body', async () => {
  const repository = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../..',
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-tool-routing-'));
  let runtime: ApplicationExtensionRuntime | undefined;
  const leases: Array<Awaited<ReturnType<typeof retainExtensionTool>>> = [];
  let closeScope: (() => void) | undefined;
  try {
    const { build } = createRequire(
      path.join(repository, 'packages/extension-builtins/package.json'),
    )('esbuild');
    const serviceId = 'example.routing.read';
    const install = async (label: string, toolName = 'routing_read') => {
      const dir = path.join(root, label);
      await fs.mkdir(dir);
      const manifest = {
        schemaVersion: 1,
        id: `example.routing-${label.toLowerCase()}`,
        displayName: label,
        version: '1.0.0',
        engines: { varin: '*' },
        capabilities: { host: [VARIN_RUNTIME_TOOLS_CAPABILITY] },
        entrypoints: {
          host: {
            file: 'host.cjs',
            mode: 'brokered',
            activation: ['service-request'],
          },
        },
        provides: {
          services: [
            {
              id: serviceId,
              version: 1,
              multiple: true,
              tool: {
                name: toolName,
                description: `Read ${label}`,
                completion: 'result',
                operation: 'read',
                inputSchema: { type: 'object' },
                outputSchema: {
                  type: 'object',
                  required: ['provider'],
                  properties: { provider: { type: 'string' } },
                },
              },
            },
          ],
        },
      };
      await fs.writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: manifest.id, version: '1.0.0' }),
      );
      await fs.writeFile(
        path.join(dir, 'varin.extension.json'),
        JSON.stringify(manifest),
      );
      const output =
        label === 'A' ? { provider: 'A' } : { original: ['B', 42] };
      await build({
        stdin: {
          contents: `import { defineHostExtension, provideTool } from '@varin/extension-sdk'; export default defineHostExtension({activate(ctx){provideTool(ctx,${JSON.stringify(manifest.provides.services[0])},async(_input,call)=>{if(${JSON.stringify(label)}==='B'){await call.output({kind:'text',text:'before invalid result'});await call.output({kind:'media',media:{media_type:'image/png',data_base64:'aW1hZ2U='}});let rejected=false;try{await call.output({kind:'media',media:{media_type:'image/png',data_base64:'AB=='}});}catch{rejected=true;}if(!rejected)throw new Error('SDK accepted noncanonical media');await call.output({kind:'text',text:'invalid media rejected'});}return ${JSON.stringify(output)};});}});`,
          resolveDir: repository,
        },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: path.join(dir, 'host.cjs'),
        alias: {
          '@varin/extension-sdk': path.join(
            repository,
            'packages/extension-sdk/dist/index.js',
          ),
        },
      });
      await runtime!.installOrStage({
        source: { kind: 'local', display: label, specifier: dir },
        expectedRevision: (await runtime!.catalog.snapshot()).revision,
      });
      await runtime!.reviewCapabilities({ extensionId: manifest.id, expectedRevision: (await runtime!.catalog.snapshot()).revision,
        decisions: [{ capability: VARIN_RUNTIME_TOOLS_CAPABILITY, realm: 'host', granted: true }] });
      await runtime!.setEnabled(
        manifest.id,
        true,
        (await runtime!.catalog.snapshot()).revision,
      );
      return manifest.id;
    };
    runtime = await ApplicationExtensionRuntime.create({
      dataDir: path.join(root, 'extensions'),
      varinVersion: '0.9.25',
      brokerScript: path.join(
        repository,
        'packages/extension-host/broker/broker-child.mjs',
      ),
    });
    runtime.capabilities.register(VARIN_RUNTIME_TOOLS_CAPABILITY, createNestedToolOwner({ agentRuntimeRequest() { throw new Error('This fixture must only emit output, never invoke another tool'); } } as unknown as KernelClient));
    await runtime.start();
    const a = await install('A'),
      b = await install('B');
    const route = async (extensionId: string) =>
      runtime!.upsertServiceRoutingRule({
        expectedRevision: (await runtime!.routing.read()).document.revision,
        rule: {
          serviceId,
          version: 1,
          providerKeys: [`${extensionId}:host:${serviceId}@1`],
          allowFallback: false,
          scope: { threadId: 'thread' },
        },
      });
    await route(a);
    const executionOwner = {
      kind: 'external' as const,
      identity: 'original',
      epoch: 'owner',
    };
    const kernel = {
      agentRuntimeRequest: async (method: string) => {
        if (method === 'runtime.operation.inspect')
          return {
            id: call!.operationId,
            run_id: 'run',
            phase: 'running',
            cancel_requested: false,
            execution_owner: executionOwner,
            intent: {
              origin: call!.origin,
              call: {
                call_id: call!.callId,
                name: call!.name,
                schema_version: call!.schemaVersion,
                arguments: call!.arguments,
              },
            },
          };
        if (method === 'runtime.run.inspect')
          return { id: 'run', thread_id: 'thread', cancel_requested: false };
        if (method === 'runtime.launch.inspect')
          return { run_id: 'run', selection: { source: null } };
        throw new Error(`unexpected query ${method}`);
      },
    } as unknown as KernelClient;
    const options = {
      runtime,
      kernel,
      configurationIdentity: Object.assign(() => null, { enabled: (value: { id: string }) => value.id === serviceId }),
      currentPolicy: async () => ({
        mode: 'normal' as const,
        rules: [{ tool: 'routing_read', decision: 'allow' as const }],
      }),
    };
    // The first model request must have its selected tool even while the
    // service-request extension has not been activated by another caller.
    expect((await runtime.state()).services.providers.some(provider => provider.extensionId === a && provider.status === 'active')).toBe(false);
   const scope = await createExtensionTools(options)(
      { runId: 'run', threadId: 'thread', branchId: 'history-branch', source: null },
      [],
      new AbortController().signal,
    );
   closeScope = () => scope.close();
    leases.push(...scope.initial);
    expect(scope.initial[0]?.binding.extensionId).toBe(a);
    const removed: string[] = [];
    let rejected: Awaited<ReturnType<typeof retainExtensionTool>> | undefined;
    let restored: Awaited<ReturnType<typeof retainExtensionTool>> | undefined;
    let observedA!: () => void;
    const restoredA = new Promise<void>(resolve => { observedA = resolve; });
    let observedB!: () => void;
    const publishedB = new Promise<void>(resolve => { observedB = resolve; });
   scope.start(async (_slot, lease, revoked) => {
      if (lease && lease.binding.extensionId === a && removed.includes(a)) {
        restored = lease;
        leases.push(lease);
        observedA();
        return;
      }
      if (lease) {
        if (lease.binding.extensionId === b) { rejected = lease; observedB(); }
        lease.lease.release();
        throw new Error('directory rejects candidate');
      }
      if (revoked) removed.push(revoked.binding.extensionId);
    });
   await route(b);
    await publishedB;
    expect(rejected?.binding.extensionId).toBe(b);
    await expect.poll(() => scope.inspect().find(state => state.serviceId === serviceId)?.status).toBe('unavailable');
    // Reconstruct the saved exact A while current routing points to B. Only subsequent
    // new candidate preparation follows B; recovery never silently rewrites the old binding.
    const recovered = await createExtensionTools(options)(
      { runId: 'recovered', threadId: 'thread', branchId: 'history-branch', source: null },
      [scope.initial[0]!.binding],
      new AbortController().signal,
    );
    try {
      expect(recovered.initial[0]!.binding).toEqual(scope.initial[0]!.binding);
      let nextProvider: string | undefined;
      let observedNext!: () => void;
      const next = new Promise<void>(resolve => { observedNext = resolve; });
      recovered.start(async (_slot, lease) => {
        if (lease) {
          if (lease.binding.extensionId === b) { nextProvider = lease.binding.extensionId; observedNext(); }
          lease.lease.release();
        }
      });
      await next;
      expect(nextProvider).toBe(b);
    } finally {
      recovered.close();
      for (const retained of recovered.initial) retained.lease.release();
    }

    // Damage only the unrelated current-selection routing file. The saved exact A owner
    // remains recoverable, but stale routing must not prepare or publish any new candidate.
    const routingPath = path.join(
      runtime.storage.directory,
      'varin.core.service-routing',
      'application',
      `${createHash('sha256').update('rules').digest('hex')}.json`,
    );
    const routingBytes = await fs.readFile(routingPath);
    await fs.writeFile(routingPath, '{truncated');
    let staleRecovered:
      Awaited<ReturnType<ReturnType<typeof createExtensionTools>>> | undefined;
    try {
      const stale = await runtime.state();
      expect(stale.catalog.authoritative).toBe(true);
      expect(stale.routing.authoritative).toBe(false);
      staleRecovered = await createExtensionTools(options)(
        { runId: 'stale-recovery', threadId: 'thread', branchId: 'history-branch', source: null },
        [scope.initial[0]!.binding],
        new AbortController().signal,
      );
      expect(staleRecovered.initial[0]!.binding).toEqual(
        scope.initial[0]!.binding,
      );
      expect(
        staleRecovered.initial[0]!.lease.available(
          staleRecovered.initial[0]!.binding.tool,
        ),
      ).toBe(true);
      await expect(
        createExtensionTools(options)(
          { runId: 'new-selection', threadId: 'thread', branchId: 'history-branch', source: null },
          [],
          new AbortController().signal,
        ),
      ).rejects.toThrow('extension_tool_catalog_unavailable');
      const state = runtime.state.bind(runtime);
      let snapshotRead!: () => void;
      const read = new Promise<void>((resolve) => {
        snapshotRead = resolve;
      });
      const stateSpy = vi
        .spyOn(runtime, 'state')
        .mockImplementationOnce(async () => {
          try {
            return await state();
          } finally {
            snapshotRead();
          }
        });
      const prepareSpy = vi.spyOn(runtime, 'prepareService');
      const candidates: string[] = [];
      try {
        staleRecovered.start(async (_slot, lease) => {
          if (lease) {
            candidates.push(lease.binding.extensionId);
            lease.lease.release();
          }
        });
        await read;
        await Promise.resolve();
        expect(prepareSpy).not.toHaveBeenCalled();
        expect(candidates).toEqual([]);
      } finally {
        stateSpy.mockRestore();
        prepareSpy.mockRestore();
      }
    } finally {
      staleRecovered?.close();
      for (const retained of staleRecovered?.initial ?? [])
        retained.lease.release();
      await fs.writeFile(routingPath, routingBytes);
    }

    // The selected B really executes through its installed SDK/broker, but returns invalid output.
    const selected = await runtime.prepareService({
      serviceId,
      version: 1,
      method: 'execute',
      args: [],
      routing: { threadId: 'thread' },
    });
    const invalid = await retainExtensionTool(options, selected);
    leases.push(invalid);
    const call: HostToolCall = {
      runId: 'run',
      operationId: 'request:tool:invalid',
      origin: { kind: 'model_step', request_id: 'request' },
      callId: 'invalid',
      name: invalid.binding.tool.name,
      schemaVersion: invalid.binding.tool.version,
      arguments: {},
    };
    await invalid.lease.authorize(call, new AbortController().signal);
    expect(
      await invalid.lease.execute(
        call,
        new AbortController().signal,
        executionOwner,
      ),
    ).toEqual({
      executor_stopped: true,
      completion: {
        kind: 'result',
        outcome: 'failed',
        effect: 'none',
        content: { data: {
          error: 'extension_tool_output_schema_invalid',
          output: { original: ['B', 42] },
        }, parts: [{ kind: 'text', text: 'before invalid result' }, { kind: 'media', media: { media_type: 'image/png', data_base64: 'aW1hZ2U=' } }, { kind: 'text', text: 'invalid media rejected' }] },
      },
    });
    await runtime.setEnabled(
      b,
      false,
      (await runtime.catalog.snapshot()).revision,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(removed).toEqual([]);
    expect(
      scope.initial[0]!.lease.available(scope.initial[0]!.binding.tool),
    ).toBe(true);
    await runtime.setEnabled(
      a,
      false,
      (await runtime.catalog.snapshot()).revision,
    );
    await expect.poll(() => removed).toEqual([a]);
    await expect(
      createExtensionTools(options)(
        { runId: 'disabled', threadId: 'thread', branchId: 'history-branch', source: null },
        [scope.initial[0]!.binding],
        new AbortController().signal,
      ),
    ).rejects.toThrow(/artifact.*unavailable/i);
    await route(a);
    await runtime.setEnabled(
      a,
      true,
      (await runtime.catalog.snapshot()).revision,
    );
    await restoredA;
    expect(restored?.binding.extensionId).toBe(a);
    expect(restored!.generation).not.toBe(scope.initial[0]!.generation);
    expect(restored!.lease.available(restored!.binding.tool)).toBe(true);
    expect(
      scope.initial[0]!.lease.available(scope.initial[0]!.binding.tool),
    ).toBe(false);
    scope.close(); closeScope = undefined;
    const researchId = await install('Research', 'research_search');
    await route(researchId);
    for (const workFocus of ['code', 'research'] as const) {
      const focused = await createExtensionTools(options)(
        { runId: `focus-${workFocus}`, threadId: 'thread', branchId: 'history-branch', source: null, workFocus }, [], new AbortController().signal);
      try {
        expect(focused.initial.map(value => value.binding.tool.name)).toEqual(['research_search']);
        expect(focused.initial[0]!.binding.tool.metadata?.always_declared === true).toBe(workFocus === 'research');
      } finally { focused.close(); for (const retained of focused.initial) retained.lease.release(); }
    }
  } finally {
    closeScope?.();
    for (const retained of leases) retained.lease.release();
    try {
      await runtime?.stop();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}, 20_000);
