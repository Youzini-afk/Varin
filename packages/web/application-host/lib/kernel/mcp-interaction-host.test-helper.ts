/** One original MCP authority and the actual interaction/Task/permission owners for integration. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpAuthority, McpCompositions, type McpCompositionScope, type McpAuthorityOptions } from '../mcp/authority.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { ToolBridge } from './tool-bridge.js';
import { createMcpLease } from './mcp-owner.js';
import { createMcpInteractionRuntime } from './mcp-interaction-runtime.js';
import { createMcpTaskRuntime } from './mcp-task-runtime.js';
import { createMcpTaskRecovery } from './mcp-task-recovery.js';
import { createInteractionConsumer } from './mcp-interaction-consumer.test-helper.js';
import { createInteractionHttpPeer, writeInteractionStdioConfiguration } from './mcp-interaction-peer.test-helper.js';
import { fixtureMcpStdio } from './mcp-stdio.test-helper.js';

export async function createInteractionFixture(options: { root: string; mode: 'http' | 'stdio'; kernel: KernelClient;
  runtime: AgentRuntimeClient; bridge: ToolBridge; sampling?: boolean; onError(error: Error): void }) {
  const { root, kernel, runtime, bridge } = options;
  const interactions = createMcpInteractionRuntime({ kernel, runtime, onError: options.onError });
  runtime.setMcpInteractionOwner(interactions);
  const http = options.mode === 'http' ? createInteractionHttpPeer(root) : undefined;
  const agentDir = http ? join(root, 'agent') : writeInteractionStdioConfiguration(root);
  if (http) { await mkdir(agentDir, { recursive: true }); await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: {
    original: { url: 'https://receiver.invalid/mcp', exposure: 'direct' },
  } })); }
  const authority = new McpAuthority({ interactions: input => interactions.receiver(input),
    adaptTransport: fixtureMcpStdio,
    interactionErrors: input => interactions.errorReceiver(input),
    ...(options.sampling ? { sampling: input => interactions.samplingReceiver(input) } satisfies Partial<McpAuthorityOptions> : {}),
    ...(http ? { fetch: http.fetch as typeof globalThis.fetch } : {}) });
  const compositions = new McpCompositions(authority, code => options.onError(new Error(code)));
  const recovery = createMcpTaskRecovery({ kernel, authority, agentDir, hostId: 'fixture-host',
    admitWorkspaceRegistration: async () => { throw new Error('Source-less interaction acquired a workspace'); }, projectTrusted: () => false,
    validateLiveSource: async () => { throw new Error('Source-less interaction acquired a file source'); } });
  const tasks = createMcpTaskRuntime({ kernel, runtime, recover: recovery, onError: options.onError });
  const models = options.sampling ? (await import('./mcp-sampling-model.test-helper.js')).createSamplingModelAuthority() : undefined;
  const consumer = createInteractionConsumer(runtime, models);
  const scopes: McpCompositionScope[] = [];
  let nested: Awaited<ReturnType<typeof import('./mcp-consumer-host.test-helper.js').createMcpConsumers>> | undefined;
  const baseScope = { resourceOwner: { kind: 'local' as const }, agentDir, configCwd: agentDir, executionCwd: agentDir, environmentId: 'fixture-host:global', executionScope: 'global' as const, projectTrusted: false };
  // The same product authority may connect for Pi first. That must not make the subsequent real
  // Native call's negotiated capability depend on connection order or create a second connection.
  const firstLease = await authority.acquire({ ...baseScope, sessionId: 'pi:first' }, { servers: ['original'] });
  return {
    async prepare(frame: Record<string, unknown>) {
      let changed: (() => void) | undefined;
      const scope = await compositions.observe({ ...baseScope, sessionId: `agent:${String(frame.threadId)}` }, () => changed?.());
      scopes.push(scope); let original = scope.snapshot();
      while (!original.binding.tools.some(tool => tool.tool === 'ordinary')) {
        original.release(); await new Promise<void>(resolve => { changed = resolve; }); original = scope.snapshot();
      }
      const names = Object.fromEntries(original.binding.tools.map(tool => [tool.tool, tool.name]));
      const lease = createMcpLease({ lease: original, kernel, tasks, currentPolicy: async () => ({ mode: 'normal', rules: [] }) });
      if (frame.consumer === true) {
        const { createMcpConsumers } = await import('./mcp-consumer-host.test-helper.js');
        nested = await createMcpConsumers({ root, agentDir, authority, kernel, tasks, bridge, parentMcp: lease });
        return { ...nested.prepared, names };
      }
      interactions.start(); tasks.start();
      return { live: bridge.register(String(frame.runId), lease), names };
    },
    async receive(frame: Record<string, unknown>) { assert(nested); const prepared = await nested.receive(frame); interactions.start(); return prepared; },
    consume(frame: Record<string, unknown>) { return consumer.perform(frame); },
    async complete(elicitationId: string) {
      assert(http); await tasks.reconcile(); http.complete(elicitationId);
      await new Promise<void>(resolve => setImmediate(resolve));
    },
    async finish() {
      await tasks.dispose(); await interactions.dispose(); await nested?.close(); consumer.close();
      for (const scope of scopes.splice(0)) scope.release(); firstLease.release(); compositions.close(); await authority.close(); http?.close();
      if (http) return { requests: http.peer.messages };
      const trace = (await readFile(join(root, 'interaction-trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
      return { requests: trace.filter(value => value.kind === 'received').map(({ kind: _kind, ...message }) => message) };
    },
  };
}
