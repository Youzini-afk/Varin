import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { ApplicationExtensionRuntime, HostBindingRestoreError, HostCompositionRestoreError } from '@varin/extension-host';
import { COMPUTER_CAPABILITY, COMPUTER_TOOL_DECLARATIONS, SCRIPT_CAPABILITY, SCRIPT_TOOL_DECLARATIONS, VARIN_BUILTIN_COMPUTER_EXTENSION_ID } from '@varin/extension-builtins';
import { parseVarinExtensionManifest } from '@varin/extension-contract';
import { createMaterialStoreFixture } from '../harness/web-materials.test-helper.js';
import {
  createMaterialToolOwner,
  MATERIAL_SNAPSHOT_CAPABILITY,
} from './material-tool-owner.js';
import {
  createExtensionTools,
  extendToolConfiguration,
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
import { createToolFamilySettings } from './tool-family-settings.js';

// Real bundles, file catalogs and broker processes use the suite's shared timeout.
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
    const isolated = await createExtensionTools({
      ...options,
      prepareConfiguration: async (run, required) => {
        const configuration = await computer.prepareConfiguration(run, required);
        // Configuration preparation replaces the initial selection. Keep this fixture
        // focused on the custom tool and Computer rather than cold-starting every builtin.
        return extendToolConfiguration(configuration,
          (value, original) => configuration(value, original),
          value => value.id === descriptor.id || COMPUTER_TOOL_DECLARATIONS.some(declaration => declaration.id === value.id)
            ? undefined : false);
      },
    })(
      { runId: 'independent-custom-selection', threadId: 'thread', branchId: 'history-branch', source: null }, [], new AbortController().signal,
    );
    try {
      expect(isolated.initial.map(value => value.binding.serviceId)).toEqual([descriptor.id]);
      expect(isolated.inspect()).toHaveLength(COMPUTER_TOOL_DECLARATIONS.length + 1);
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
    ).rejects.toMatchObject({ name: 'HostBindingRestoreError', code: 'extension_tool_exact_binding_unavailable', kind: 'tool', reason: 'binding_changed' });
    await runtime.setEnabled(manifest.id, false, (await runtime.catalog.snapshot()).revision);
    const refused = await createExtensionTools(options)(
      { runId: 'original-recovery', threadId: 'thread', branchId: 'history-branch', source: null },
      [retained.binding], new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(HostBindingRestoreError);
    expect(refused).toMatchObject({ code: 'extension_tool_exact_binding_unavailable', kind: 'tool', reason: 'implementation_unavailable',
      cause: { reason: 'extension_disabled', extensionId: manifest.id } });
    expect((refused as Error).cause).toBeInstanceOf(HostCompositionRestoreError);
    expect((refused as Error).message).toContain('will not select another implementation or restore permissions automatically');
  } finally {
    try {
      await runtime?.stop();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

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
      { runId: 'recovered', threadId: 'thread', branchId: 'history-branch', source: null, restoreExact: true },
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
    ).rejects.toMatchObject({ code: 'extension_tool_exact_binding_unavailable', kind: 'tool', reason: 'implementation_unavailable',
      cause: { reason: 'extension_disabled', extensionId: a } });
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
    for (const workFocus of ['general', 'code', 'research', 'office'] as const) {
      const focused = await createExtensionTools(options)(
        { runId: `focus-${workFocus}`, threadId: 'thread', branchId: 'history-branch', source: null, workFocus }, [], new AbortController().signal);
      try {
        expect(focused.initial.map(value => value.binding.tool.name)).toEqual(['research_search']);
        expect(focused.initial[0]!.binding.tool.metadata?.always_declared === true).toBe(false);
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
});

it.each(['settings', 'routing'] as const)('exact restoration defers unavailable current %s without blocking the committed directory', async unavailable => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-tool-exact-restore-'));
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: '0.9.44',
    brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  const scopes: Awaited<ReturnType<ReturnType<typeof createExtensionTools>>>[] = [];
  const leases: Awaited<ReturnType<typeof retainExtensionTool>>[] = [];
  const listeners = new Set<() => void>();
  const selectedId = 'varin.script.close', omittedId = 'varin.script.run';
  let currentFailure: Error | undefined, currentReads = 0, staleReads = 0;
  const readState = runtime.state.bind(runtime);
  const stateObserver = vi.spyOn(runtime, 'state').mockImplementation(async () => {
    const state = await readState();
    if (!state.routing.authoritative) staleReads++;
    return state;
  });
  const input = { runId: 'original', threadId: 'thread', branchId: 'history', source: {
    resource_owner: { kind: 'local' as const }, workspace_id: 'workspace', execution_workspace_id: 'workspace',
    mode: 'materialized' as const, branch_id: 'source', revision: 1, live_root: null,
  } };
  try {
    runtime.capabilities.register(SCRIPT_CAPABILITY, () => { throw new Error('Preparation must not execute'); });
    await runtime.start();
    await runtime.upsertServiceRoutingRule({ expectedRevision: (await runtime.routing.read()).document.revision,
      rule: { serviceId: omittedId, version: 1, providerKeys: [`varin.builtin.scripts:host:${omittedId}@1`],
        allowFallback: false, scope: { threadId: 'unrelated' } } });
    const routingPath = path.join(runtime.storage.directory, 'varin.core.service-routing', 'application',
      `${createHash('sha256').update('rules').digest('hex')}.json`);
    const routingBytes = await fs.readFile(routingPath);
    const prepare = createExtensionTools({ runtime, kernel: {} as KernelClient, currentPolicy: async () => ({ mode: 'normal', rules: [] }),
      prepareConfiguration: async (_run, required) => {
        if (!required.length) { currentReads++; if (currentFailure) throw currentFailure; }
        return Object.assign((descriptor: { id: string }, original?: string | null) => original === undefined
          ? descriptor.id === omittedId ? 'configuration' : null : original,
        { enabled: (descriptor: { id: string }) => required.length > 0 || [selectedId, omittedId].includes(descriptor.id) });
      }, subscribeConfiguration: listener => { listeners.add(listener); return () => listeners.delete(listener); } });
    const original = await prepare(input, [], new AbortController().signal);
    scopes.push(original); leases.push(...original.initial);
    const saved = structuredClone(original.initial.find(lease => lease.binding.serviceId === selectedId)!.binding);
    original.close();
    if (unavailable === 'settings') currentFailure = new Error('current settings snapshot unavailable');
    else await fs.writeFile(routingPath, '{truncated');
    // A new admission still requires current settings. Exact recovery does not.
    await expect(prepare({ ...input, runId: 'pending' }, [], new AbortController().signal))
      .rejects.toThrow(currentFailure?.message ?? 'extension_tool_catalog_unavailable');
    const readsBeforeRestore = currentReads;
    const recovered = await prepare({ ...input, runId: 'recovered', restoreExact: true }, [saved], new AbortController().signal);
    scopes.push(recovered); leases.push(...recovered.initial);
    expect(currentReads).toBe(readsBeforeRestore);
    expect(recovered.initial.map(lease => lease.binding)).toEqual([saved]);
    expect(recovered.initial[0]!.lease.available(saved.tool)).toBe(true);
    const publications: string[] = [], previousReads = currentReads, previousStaleReads = staleReads;
    recovered.start(async (_slot, lease) => { if (lease) { publications.push(lease.binding.serviceId); leases.push(lease); } });
    await expect.poll(() => currentReads).toBeGreaterThan(previousReads);
    if (unavailable === 'routing') await expect.poll(() => staleReads).toBeGreaterThan(previousStaleReads);
    expect(publications).toEqual([]);
    currentFailure = undefined;
    if (unavailable === 'routing') await fs.writeFile(routingPath, routingBytes);
    for (const listener of listeners) listener();
    // Current discovery resumes through the existing live subscription, without a fence.
    await expect.poll(() => publications).toContain(selectedId);
    await expect.poll(() => publications).toContain(omittedId);
  } finally {
    for (const scope of scopes) scope.close();
    for (const lease of leases) lease.lease.release();
    stateObserver.mockRestore();
    await runtime.stop(); await fs.rm(root, { recursive: true, force: true });
  }
});

it('explicit empty directory needs no current configuration or discovery snapshot', async () => {
  const state = vi.fn(async () => { throw new Error('current discovery unavailable'); });
  const prepareConfiguration = vi.fn(async () => { throw new Error('current settings unavailable'); });
  const prepare = createExtensionTools({ runtime: { state, subscribe: () => () => {} } as unknown as ApplicationExtensionRuntime,
    kernel: {} as KernelClient, currentPolicy: async () => ({ mode: 'normal', rules: [] }), prepareConfiguration });
  const input = { runId: 'empty', threadId: 'thread', branchId: 'history', source: null, restoreExact: true };
  const scope = await prepare(input, [], new AbortController().signal);
  try {
    expect(scope.initial).toEqual([]);
    expect(state).not.toHaveBeenCalled();
    expect(prepareConfiguration).not.toHaveBeenCalled();
  } finally { scope.close(); }
  const aborted = new AbortController(); aborted.abort(new Error('preparation cancelled'));
  await expect(prepare(input, [], aborted.signal)).rejects.toThrow('preparation cancelled');
});


it('new roots discover current enabled tools after an empty or disabled prior directory, while prepared roots restore exactly', async () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-tool-current-directory-'));
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: '0.9.44',
    brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  const scopes: Awaited<ReturnType<ReturnType<typeof createExtensionTools>>>[] = [];
  const leases: Awaited<ReturnType<typeof retainExtensionTool>>[] = [];
  const listeners = new Set<() => void>();
  const enabled = new Set<string>();
  const settings = createToolFamilySettings(SCRIPT_TOOL_DECLARATIONS, async () => ({
    global: { harness: { tools: Object.fromEntries(SCRIPT_TOOL_DECLARATIONS.map(value => [value.tool!.name, enabled.has(value.id)])) } },
    globalRevision: '1', projectRevision: 'none', project: {}, projectTrusted: false,
  }));
  const input = { runId: 'automatic', threadId: 'thread', branchId: 'history', source: {
    resource_owner: { kind: 'local' as const }, workspace_id: 'workspace', execution_workspace_id: 'workspace',
    mode: 'materialized' as const, branch_id: 'source', revision: 1, live_root: null,
  } };
  try {
    runtime.capabilities.register(SCRIPT_CAPABILITY, () => { throw new Error('Preparation must not execute'); });
    await runtime.start();
    const prepare = createExtensionTools({ runtime, kernel: {} as KernelClient, currentPolicy: async () => ({ mode: 'normal', rules: [] }),
      prepareConfiguration: (run, required) => settings.prepareConfiguration(run, required,
        Object.assign(() => null, { enabled: (descriptor: { id: string }) => descriptor.id.startsWith('varin.script.') })),
      subscribeConfiguration: listener => { listeners.add(listener); return () => listeners.delete(listener); } });
    const open = async (run: Parameters<typeof prepare>[0], required: Parameters<typeof prepare>[1] = []) => {
      const scope = await prepare(run, required, new AbortController().signal);
      scopes.push(scope); leases.push(...scope.initial); return scope;
    };
    const empty = await open(input);
    expect(empty.initial).toEqual([]); empty.close();
    enabled.add('varin.script.close');
    const current = await open({ ...input, runId: 'next-root' });
    expect(current.initial.map(value => value.binding.serviceId)).toEqual(['varin.script.close']);
    const saved = current.initial.map(value => structuredClone(value.binding)); current.close();
    enabled.clear();
    const disabled = await open({ ...input, runId: 'disabled-next-root' });
    expect(disabled.initial).toEqual([]); disabled.close();
    const exact = await open({ ...input, runId: 'original-root', restoreExact: true }, saved);
    expect(exact.initial.map(value => value.binding)).toEqual(saved); exact.close();
    enabled.add('varin.script.run');
    // A committed empty initial directory stays empty at restoration, but ordinary
    // live candidates remain enabled at subsequent closed publication boundaries.
    const restoredEmpty = await open({ ...input, runId: 'empty-original', restoreExact: true });
    expect(restoredEmpty.initial).toEqual([]);
    const published: string[] = [];
    restoredEmpty.start(async (_slot, lease) => { if (lease) { published.push(lease.binding.serviceId); leases.push(lease); } });
    await expect.poll(() => published).toContain('varin.script.run');
    const next = await open({ ...input, runId: 'new-current-root' });
    expect(next.initial.map(value => value.binding.serviceId)).toEqual(['varin.script.run']); next.close();
    const sourceless = await open({ ...input, runId: 'sourceless-root', source: null });
    expect(sourceless.initial).toEqual([]);
    expect(sourceless.inspect()).toContainEqual(expect.objectContaining({ serviceId: 'varin.script.run', status: 'unavailable',
      error: 'extension_tool_source_unavailable:varin.script.run:requires_physical' }));
    const frozenEmpty = await open({ ...input, runId: 'child', fixed: true });
    expect(frozenEmpty.initial).toEqual([]);
    frozenEmpty.start(async () => { throw new Error('A delegated empty directory must remain frozen'); });
    for (const listener of listeners) listener();
  } finally {
    for (const scope of scopes) scope.close();
    for (const lease of leases) lease.lease.release();
    await runtime.stop(); await fs.rm(root, { recursive: true, force: true });
  }
});
