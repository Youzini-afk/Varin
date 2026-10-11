import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { parseVarinExtensionManifest } from '@varin/extension-contract';
import { retainExtensionTool } from './extension-tool-owner.js';
import { createNestedToolOwner, VARIN_RUNTIME_TOOLS_CAPABILITY } from './nested-tool-owner.js';
import { createNestedMemoryHostFixture } from './nested-memory-host.test-helper.js';
import { ToolBridge, type HostToolCall, type PrivateToolFrame } from './tool-bridge.js';
import type { KernelClient } from './kernel-client.js';
import { toolOperationId, type ExecutorOwner, type NestedToolInvokeParams, type NestedToolReceipt, type ToolOrigin } from './protocol.generated.js';
import type { MemoryQuery } from './memory-owner.js';

it('installed nested-tools uses actual SDK, broker scope, runtime capability and original Host memory owner', async () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-nested-installed-'));
  const memory = createNestedMemoryHostFixture();
  let runtime: ApplicationExtensionRuntime | undefined;
  let bridge: ToolBridge | undefined;
  try {
    const source = path.join(repository, 'examples/extensions/nested-tools'), example = path.join(root, 'example');
    await fs.mkdir(path.join(example, 'dist'), { recursive: true });
    for (const file of ['package.json', 'varin.extension.json']) await fs.copyFile(path.join(source, file), path.join(example, file));
    // Reuse already-built workspace packages; no registry install or empty dependency marker.
    // esbuild bundles their runtime code, while the local artifact retains actual dependencies.
    for (const name of ['extension-sdk', 'extension-contract']) {
      const dependency = path.join(example, 'node_modules/@varin', name);
      await fs.mkdir(dependency, { recursive: true });
      await fs.copyFile(path.join(repository, 'packages', name, 'package.json'), path.join(dependency, 'package.json'));
      await fs.cp(path.join(repository, 'packages', name, 'dist'), path.join(dependency, 'dist'), { recursive: true });
    }

    const manifest = parseVarinExtensionManifest(JSON.parse(await fs.readFile(path.join(example, 'varin.extension.json'), 'utf8')));
    const descriptor = manifest.provides!.services![0]!;
    const { build } = createRequire(path.join(repository, 'packages/extension-builtins/package.json'))('esbuild');
    await build({ entryPoints: [path.join(source, 'host.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(example, 'dist/host.cjs'),
      alias: { '@varin/extension-sdk': path.join(repository, 'packages/extension-sdk/dist/index.js'), '@varin/extension-contract': path.join(repository, 'packages/extension-contract/dist/index.js') } });
    runtime = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: '0.9.25',
      brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
    let invocation!: HostToolCall;
    const requests: NestedToolInvokeParams[] = [], queries: MemoryQuery[] = [];
    // Explicit management/Kernel dispatch fixture for this Host segment. The native counterpart
    // runs actual RunAssembly/MemoryTools against this same Host memory fixture over private frames.
    // Neither segment claims product socket IPC in an environment that denies listeners.
    const kernel = { agentRuntimeRequest: async (method: string, params: unknown) => {
      if (method === 'runtime.operation.inspect') return { id: invocation.operationId, run_id: invocation.runId, phase: 'running', cancel_requested: false,
        execution_owner: executionOwner, intent: { origin: invocation.origin, call: { call_id: invocation.callId, name: invocation.name,
          schema_version: invocation.schemaVersion, arguments: invocation.arguments } } };
      if (method === 'runtime.run.inspect') return { id: invocation.runId, thread_id: 'thread', cancel_requested: false };
      if (method === 'runtime.launch.inspect') return { run_id: invocation.runId, selection: { source: null } };
      if (method !== 'runtime.tools.invoke') throw new Error(`unexpected management query: ${method}`);
      const input = params as NestedToolInvokeParams;
      expect(input.parentOperationId).toBe(invocation.operationId); expect(input.executorOwner).toEqual(executionOwner);
      expect(Object.keys(input.call).sort()).toEqual(['arguments', 'callId', 'name']);
      expect(input.call.name).toBe('memory'); requests.push(structuredClone(input));
      const operationId = toolOperationId({ kind: 'nested_call', parent_operation_id: invocation.operationId }, input.call.callId);
      const query: MemoryQuery = { action: 'tool', runId: invocation.runId, scope: { mode: 'agent', sessionId: 'thread', projectId: null },
        origin: `run:${invocation.runId}:${operationId}`, arguments: input.call.arguments as NonNullable<MemoryQuery['arguments']> };
      queries.push(query);
      const response = await memory.dispatch({ v: 1, kind: 'memory-request', id: `memory-${requests.length}`, kernelEpoch: 'epoch', query });
      expect(response.result.status).toBe('ready');
      return { operationId, completion: { kind: 'result', outcome: 'succeeded', effect: query.arguments!.action === 'read' ? 'none' : 'confirmed', content: { data: response.result, parts: [] } } } satisfies NestedToolReceipt;
    } } as unknown as KernelClient;
    runtime.capabilities.register(VARIN_RUNTIME_TOOLS_CAPABILITY, createNestedToolOwner(kernel));
    await runtime.start();
    await runtime.installOrStage({ source: { kind: 'local', display: 'Nested example', specifier: example }, expectedRevision: (await runtime.catalog.snapshot()).revision });
    await runtime.reviewCapabilities({ extensionId: manifest.id, expectedRevision: (await runtime.catalog.snapshot()).revision,
      decisions: [{ capability: VARIN_RUNTIME_TOOLS_CAPABILITY, realm: 'host', granted: true }] });
    await runtime.setEnabled(manifest.id, true, (await runtime.catalog.snapshot()).revision);
    const selected = await runtime.prepareService({ serviceId: descriptor.id, version: descriptor.version, method: 'execute', args: [], routing: { sessionId: 'thread' } });
    const retained = await retainExtensionTool({ runtime, kernel, currentPolicy: async () => ({ mode: 'normal', rules: [{ tool: descriptor.tool!.name, decision: 'allow' }] }) }, selected);
    const frames: PrivateToolFrame[] = [];
    bridge = new ToolBridge(() => 'epoch', async frame => {
      frames.push(frame);
      if (frame.kind === 'host-tool-receipt') queueMicrotask(() => bridge!.consume({ v: 1, kind: 'host-tool-receipt-ack', kernelEpoch: 'epoch', id: frame.id, accepted: true }));
    }, () => { throw new Error('fixture tool transport failed'); });
    const live = bridge.register('run', retained.lease);
    const executionOwner: ExecutorOwner = { kind: 'external', identity: retained.binding.providerKey, epoch: live.ownerId };
    bridge.consume({ v: 1, kind: 'host-tool-binding-retain', kernelEpoch: 'epoch', runId: 'run', ownerId: live.ownerId, holderId: 'holder' });
    for (const kind of ['model', 'policy'] as const) {
      const origin: ToolOrigin = kind === 'model' ? { kind: 'model_step', request_id: 'request' } : { kind: 'policy_action', action_id: 'action', node_id: 'outer' };
      const revision = (await memory.personalization.catalog()).revision;
      invocation = { runId: 'run', origin, callId: 'outer', operationId: toolOperationId(origin, 'outer'), name: descriptor.tool!.name, schemaVersion: retained.binding.tool.version,
        arguments: { memory: { action: 'save', scope: 'currentThread', content: `explicit nested ${kind}`, revision } } };
      const send = (phase: 'authorize' | 'execute') => bridge!.consume({ v: 1, kind: 'host-tool-request', id: `${kind}:${phase}`, kernelEpoch: 'epoch', phase,
        binding: { ownerId: live.ownerId, reference: retained.binding.providerKey, generation: retained.generation, holderId: 'holder' }, call: invocation });
      send('authorize');
      await expect.poll(() => frames.find(frame => frame.kind === 'host-tool-response' && frame.id === `${kind}:authorize`)).toMatchObject({ ok: true });
      send('execute');
      const nestedId = toolOperationId({ kind: 'nested_call', parent_operation_id: invocation.operationId }, 'memory');
      await expect.poll(() => frames.find(frame => frame.kind === 'host-tool-response' && frame.id === `${kind}:execute`)).toMatchObject({ executor_stopped: true,
        completion: { kind: 'result', outcome: 'succeeded', content: { data: { memory: { operationId: nestedId, completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed',
          content: { data: { memoryReceipt: { origin: `run:run:${nestedId}`, revision: revision + 1 } }, parts: [] } } }, read: { status: 'not_requested' } }, parts: [] } } });
      expect((await memory.personalization.context('thread')).memories).toContainEqual(expect.objectContaining({ content: `explicit nested ${kind}` }));
      const writes = memory.writes();
      const originalQuery = queries.at(-1)!;
      expect(await memory.owner({ ...originalQuery, action: 'receipt' }, new AbortController().signal)).toEqual(memory.pairs.at(-1)!.response.result);
      expect(memory.writes()).toBe(writes);
    }
    expect(requests).toHaveLength(2); expect(memory.writes()).toBe(2);
  } finally {
    bridge?.close(); memory.close(); await runtime?.stop(); await fs.rm(root, { recursive: true, force: true });
  }
});
