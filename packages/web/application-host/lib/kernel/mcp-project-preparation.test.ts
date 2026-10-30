import { expect, it, vi } from 'vitest';
import { AgentRuntimeClient, type McpPreparation } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { DelegatedExecution, LaunchIntent, McpBinding } from './protocol.generated.js';
import type { McpToolLease } from './tool-bridge.js';

it('discovers the target project on initial dispatch, restores it after restart and retargets frozen definitions on reuse', async () => {
  const binding = { reference: 'target-project', generation: 1, tools: [{ name: 'mcp_discover' }], routes: {}, resources: {}, provenance: { servers: {} } } as McpBinding;
  const lease = { binding, release: vi.fn() } as unknown as McpToolLease;
  const prepare = vi.fn(async (_input: McpPreparation) => lease);
  const kernel = { subscribeExit: () => () => {}, onToolReleased: () => () => {},
    beginRunPreparation: () => ({ signal: new AbortController().signal, release: () => {} }),
    mcpBinding: () => undefined, agentRuntimeRequest: vi.fn(async () => ({})), registerMcpOwner: vi.fn(async () => binding) } as unknown as KernelClient;
  const runtime = new AgentRuntimeClient(kernel, prepare);
  const child = { selected_profile: { project_mcp: { project: { id: 'project', path: '/target', resource_owner: { kind: 'local' } }, tools: null } },
    trigger: { kind: 'dispatch' }, launch: { mcp_binding: undefined } } as unknown as DelegatedExecution;
  let saved = { bound_epoch: null, selection: { mcp_binding: undefined } } as unknown as LaunchIntent;
  vi.spyOn(runtime, 'launch').mockImplementation(async () => saved);
  vi.spyOn(runtime, 'run').mockResolvedValue({ id: 'run', thread_id: 'thread' } as never);
  vi.spyOn(runtime, 'childExecutionForRun').mockResolvedValue(child);
  await runtime.prepareMcp('run', null, '/target');
  expect(prepare.mock.calls.at(-1)?.[0]).toMatchObject({ projectDiscovery: true, fixed: true });
  expect(prepare.mock.calls.at(-1)?.[0].delegatedBinding).toBeUndefined();
  saved = { ...saved, bound_epoch: 1, selection: { ...saved.selection, mcp_binding: binding } };
  await runtime.prepareMcp('run', null, '/target');
  expect(prepare.mock.calls.at(-1)?.[0].projectDiscovery).toBeUndefined();
  expect(prepare.mock.calls.at(-1)?.[0].requiredBinding).toBe(binding);
  child.trigger = { kind: 'message_request' } as never;
  child.launch.mcp_binding = binding;
  saved = { ...saved, bound_epoch: null };
  await runtime.prepareMcp('run', null, '/target');
  expect(prepare.mock.calls.at(-1)?.[0].projectDiscovery).toBeUndefined();
  expect(prepare.mock.calls.at(-1)?.[0].delegatedBinding).toBe(binding);
  expect(kernel.registerMcpOwner).toHaveBeenCalledTimes(3);
});
