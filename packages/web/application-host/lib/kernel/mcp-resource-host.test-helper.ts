/** Original resource owners for the shared Rust/Host stdio rendezvous. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpAuthority, McpCompositions, McpCompositionScope } from '@varin/pi-host/mcp-authority';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { ToolBridge } from './tool-bridge.js';
import { createMcpLease } from './mcp-owner.js';
import { createMcpResourceRuntime } from './mcp-resource-runtime.js';
import { createMcpResourceRecovery } from './mcp-resource-recovery.js';
import { writeResourcePeer } from './mcp-resource-peer.test-helper.js';

export async function createResourceFixture(options: {
  root: string; kernel: KernelClient; runtime: AgentRuntimeClient;
  authority: McpAuthority; compositions: McpCompositions; bridge: ToolBridge;
  onError(error: Error): void;
}) {
  const { root, kernel, runtime, authority, compositions, bridge } = options;
  const { agentDir } = await writeResourcePeer(root);
  const scopes: McpCompositionScope[] = [];
  let consumer: Awaited<ReturnType<typeof import('./mcp-consumer-host.test-helper.js').createMcpConsumers>> | undefined;
  const resources = createMcpResourceRuntime({ kernel, runtime,
    recover: createMcpResourceRecovery({ kernel, authority, agentDir, hostId: 'fixture-host',
      admitWorkspaceRegistration: async () => { throw new Error('Global resource observer requested a workspace'); },
      projectTrusted: () => false,
      currentPolicy: async () => ({ mode: 'normal', rules: [] }),
      validateLiveSource: async () => { throw new Error('Global resource observer requested a live source'); },
    }), onError: options.onError,
  });
  return {
    async prepare(frame: Record<string, unknown>) {
      let changed: (() => void) | undefined;
      const scope = await compositions.observe({ agentDir, configCwd: agentDir, executionCwd: agentDir,
        environmentId: 'fixture-host:global', executionScope: 'global', projectTrusted: false,
        sessionId: `agent:${String(frame.threadId ?? 'thread')}` }, () => changed?.());
      scopes.push(scope);
      let original = scope.snapshot();
      while (!original.binding.servers.some(server => server.name === 'original' && server.status === 'connected')) {
        original.release(); await new Promise<void>(resolve => { changed = resolve; });
        original = scope.snapshot();
      }
      const service = (await original.discoverServices('original', new AbortController().signal))
        .find(value => value.kind === 'resources');
      assert(service, 'original receiver resource capability was not negotiated');
      const lease = createMcpLease({ lease: original, kernel, resources,
        currentPolicy: async () => ({ mode: 'normal', rules: [] }) });
      if (frame.consumer === true) {
        const { createMcpConsumers } = await import('./mcp-consumer-host.test-helper.js');
        consumer = await createMcpConsumers({ root, agentDir, authority, kernel, resources, bridge, parentMcp: lease });
        return { ...consumer.prepared, schemaVersion: service.schemaVersion };
      }
      resources.start();
      return { live: bridge.register(String(frame.runId), lease), schemaVersion: service.schemaVersion };
    },
    async receive(frame: Record<string, unknown>) {
      assert(consumer); return consumer.receive(frame);
    },
    async finish() {
      await resources.dispose();
      await consumer?.close();
      for (const scope of scopes.splice(0)) scope.release();
      const trace = (await readFile(join(root, 'resource-trace.jsonl'), 'utf8')).trim();
      return { requests: trace ? trace.split('\n').map(line => JSON.parse(line)) : [] };
    },
  };
}
