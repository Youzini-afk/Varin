/** Installed SDK consumer and source-less child preparation for the original Task fixture.
 * The shared helper owns MCP, permissions, Tasks, wire frames, and its actual stdio receiver. */
import assert from 'node:assert/strict';
import { cp, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { parseVarinExtensionManifest } from '@varin/extension-contract';
import type { McpAuthority } from '@varin/pi-host/mcp-authority';
import type { KernelClient } from './kernel-client.js';
import type { McpTaskRuntime } from './mcp-task-runtime.js';
import { createChildMcpPreparer } from './mcp-child-preparation.js';
import { retainExtensionTool } from './extension-tool-owner.js';
import { createNestedToolOwner, VARIN_RUNTIME_TOOLS_CAPABILITY } from './nested-tool-owner.js';
import { ToolBridge, type McpToolLease } from './tool-bridge.js';
import type { ExtensionToolBinding, McpBinding } from './protocol.generated.js';

export async function createTaskConsumers(options: {
  root: string;
  agentDir: string;
  authority: McpAuthority;
  kernel: KernelClient;
  tasks: McpTaskRuntime;
  bridge: ToolBridge;
  parentMcp: McpToolLease;
}) {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const example = join(options.root, 'nested-task-extension');
  await mkdir(join(example, 'dist'), { recursive: true });
  const manifest = parseVarinExtensionManifest({
    schemaVersion: 1, id: 'review.mcp-task-consumer', displayName: 'Task receipt consumer', version: '1.0.0',
    engines: { varin: '*' },
    entrypoints: { host: { file: 'dist/host.cjs', mode: 'brokered', activation: ['service-request'] } },
    capabilities: { host: [VARIN_RUNTIME_TOOLS_CAPABILITY] },
    provides: { services: [{ id: 'review.mcp-task-consumer.invoke', version: 1, tool: {
      name: 'consume_task', description: 'Return the original nested tool receipt unchanged.', completion: 'result', operation: 'effect',
      inputSchema: { type: 'object', properties: { callId: { type: 'string' }, name: { type: 'string' }, arguments: { type: 'object' } },
        required: ['callId', 'name', 'arguments'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { operationId: { type: 'string' }, completion: { type: 'object' } },
        required: ['operationId', 'completion'], additionalProperties: false },
    } }] },
  });
  await writeFile(join(example, 'package.json'), JSON.stringify({ name: 'varin-mcp-task-consumer-review', version: '1.0.0',
    private: true, dependencies: { '@varin/extension-sdk': 'workspace:*', '@varin/extension-contract': 'workspace:*' } }));
  await writeFile(join(example, 'varin.extension.json'), JSON.stringify(manifest));
  for (const name of ['extension-sdk', 'extension-contract']) {
    const dependency = join(example, 'node_modules/@varin', name);
    await mkdir(dependency, { recursive: true });
    await copyFile(join(repository, 'packages', name, 'package.json'), join(dependency, 'package.json'));
    await cp(join(repository, 'packages', name, 'dist'), join(dependency, 'dist'), { recursive: true });
  }
  const source = join(example, 'host.ts');
  await writeFile(source, `import { defineHostExtension, provideTool } from '@varin/extension-sdk';
import { parseVarinToolJson } from '@varin/extension-contract';
import manifest from './varin.extension.json';
export default defineHostExtension({ activate(context) {
  provideTool(context, manifest.provides.services[0], async (input, call) =>
    parseVarinToolJson(await call.tools.invoke(input)));
} });`);
  const { build } = createRequire(join(repository, 'packages/extension-builtins/package.json'))('esbuild');
  await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', outfile: join(example, 'dist/host.cjs'),
    alias: { '@varin/extension-sdk': join(repository, 'packages/extension-sdk/dist/index.js'),
      '@varin/extension-contract': join(repository, 'packages/extension-contract/dist/index.js') } });
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(options.root, 'extensions'), varinVersion: '0.9.25',
    brokerScript: join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  runtime.capabilities.register(VARIN_RUNTIME_TOOLS_CAPABILITY, createNestedToolOwner(options.kernel));
  await runtime.start();
  await runtime.installOrStage({ source: { kind: 'local', display: 'Task consumer review', specifier: example },
    expectedRevision: (await runtime.catalog.snapshot()).revision });
  await runtime.reviewCapabilities({ extensionId: manifest.id, expectedRevision: (await runtime.catalog.snapshot()).revision,
    decisions: [{ capability: VARIN_RUNTIME_TOOLS_CAPABILITY, realm: 'host', granted: true }] });
  await runtime.setEnabled(manifest.id, true, (await runtime.catalog.snapshot()).revision);
  const descriptor = manifest.provides!.services![0]!;
  const prepareExtension = async (threadId: string, required?: ExtensionToolBinding) => {
    const service = await runtime.prepareService({ serviceId: descriptor.id, version: descriptor.version, method: 'execute',
      args: [], routing: { sessionId: threadId } });
    return retainExtensionTool({ runtime, kernel: options.kernel,
      currentPolicy: async () => ({ mode: 'normal', rules: [] }) }, service, required);
  };
  const parentExtension = await prepareExtension('thread:parent');
  const prepareChild = createChildMcpPreparer({ authority: options.authority, kernel: options.kernel, tasks: () => options.tasks,
    agentDir: options.agentDir, hostId: 'fixture-host',
    inspectWorkspace: async () => { throw new Error('Source-less child acquired a workspace'); },
    projectTrusted: () => false, currentPolicy: async () => ({ mode: 'normal', rules: [] }),
  });
  return {
    prepared: { mcpBinding: options.parentMcp.binding, extensionBinding: parentExtension.binding },
    async receive(frame: Record<string, unknown>) {
      const runId = String(frame.runId);
      if (frame.kind === 'fixture-consumer-parent') {
        const live = options.bridge.register(runId, options.parentMcp);
        const extension = options.bridge.register(runId, parentExtension.lease);
        return { live, extension: { ownerId: extension.ownerId, generation: parentExtension.generation, binding: parentExtension.binding } };
      }
      assert.equal(frame.kind, 'fixture-consumer-child');
      assert.equal(frame.source, null);
      const binding = frame.mcpBinding as McpBinding;
      assert.equal(binding.provenance.execution_scope, 'global');
      const mcp = await prepareChild({ runId, threadId: String(frame.threadId), fixed: false, source: null, delegatedBinding: binding });
      assert.deepEqual(mcp.binding.tools, binding.tools);
      assert.deepEqual(mcp.binding.routes, binding.routes);
      const extension = await prepareExtension(String(frame.threadId), frame.extensionBinding as ExtensionToolBinding);
      const live = options.bridge.register(runId, mcp);
      const extensionLive = options.bridge.register(runId, extension.lease);
      options.tasks.start();
      return { live, extension: { ownerId: extensionLive.ownerId, generation: extension.generation, binding: extension.binding } };
    },
    close: () => runtime.stop(),
  };
}
