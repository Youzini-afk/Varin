import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import type { JsonValue, VarinAgentPolicyDecision, VarinAgentPolicyInput, VarinAgentPolicyToolCompletion } from '@varin/extension-contract';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { createAgentPolicy, type AgentPolicyLease } from './agent-policy.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const { build } = createRequire(path.join(repository, 'packages/extension-builtins/package.json'))('esbuild');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-policy-child-contract-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'collaboration-policy');
  await fs.mkdir(source);
  for (const file of ['package.json', 'varin.extension.json']) {
    await fs.copyFile(path.join(repository, 'examples/extensions/collaboration-policy', file), path.join(source, file));
  }
  await build({ entryPoints: [path.join(repository, 'examples/extensions/collaboration-policy/host.ts')], bundle: true,
    platform: 'node', format: 'cjs', outfile: path.join(source, 'host.cjs'),
    alias: { '@varin/extension-sdk': path.join(repository, 'packages/extension-sdk/dist/index.js') } });
  const open = async () => {
    const runtime = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: buildVersion,
      brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
    await runtime.start();
    cleanups.push(() => runtime.stop());
    return runtime;
  };
  const runtime = await open();
  await runtime.installOrStage({ expectedRevision: (await runtime.state()).catalog.revision,
    source: { kind: 'local', display: 'Collaboration policy example', specifier: source } });
  await runtime.upsertServiceRoutingRule({ expectedRevision: (await runtime.routing.read()).document.revision,
    rule: { serviceId: 'varin.agent.policy', version: 3, providerKey: 'example.collaboration-policy:host:varin.agent.policy@3',
      scope: { sessionId: 'parent-thread' }, allowFallback: false } });
  const prepare = async (owner = runtime) => {
    const lease = await createAgentPolicy(owner)({ sessionId: 'parent-thread' });
    if (!lease) throw new Error('Installed example was not selected');
    cleanups.push(async () => { lease.release(); });
    return lease;
  };
  return { runtime, source, open, prepare };
}
function decide(lease: AgentPolicyLease, event: VarinAgentPolicyInput['event'], state: JsonValue = null) {
  return lease.decide({ view: { run_id: 'parent-run', state: 'runnable', history_count: 1,
    history_head_id: 'input', pending_tool_calls: 0, model_capabilities: [] }, event, state }, new AbortController().signal);
}
const graph = (actionId: string, nodeId: string, completion: VarinAgentPolicyToolCompletion): VarinAgentPolicyInput['event'] => ({
  kind: 'tool_graph_completed', action_id: actionId, receipts: [{ node_id: nodeId, completion }],
});
const accepted = (operationId: string, phase: string): VarinAgentPolicyToolCompletion => ({
  kind: 'job_accepted', operation_id: operationId, phase, effect: 'none', lifetime: 'thread',
});
const reference = { action_id: 'independent-read-action', node_id: 'parent-read', content_ref: 'owned-read-reference' };
async function waitingCheckpoint(lease: AgentPolicyLease): Promise<VarinAgentPolicyDecision> {
  const dispatch = await decide(lease, { kind: 'started' });
  expect(dispatch.action).toMatchObject({ kind: 'tool_graph', nodes: [{ id: 'dispatch', call: {
    name: 'dispatch', schema_version: '2', arguments: { workMode: 'read_only', tools: ['file_read', 'file_list', 'file_search'] },
  } }] });
  const read = await decide(lease, graph('dispatch-action', 'dispatch', accepted('original-child-operation', 'preparing_child')), dispatch.state);
  expect(read.action).toMatchObject({ kind: 'tool_graph', nodes: [{ id: 'parent-read', call: { name: 'file_read', arguments: { path: 'source.txt' } } }] });
  const wait = await decide(lease, graph(reference.action_id, reference.node_id, { kind: 'result', outcome: 'succeeded', effect: 'none', output: reference }), read.state);
  expect(wait.action).toMatchObject({ kind: 'tool_graph', nodes: [{ id: 'wait-child', call: { name: 'wait_child', arguments: { operationId: 'original-child-operation' } } }] });
  expect(wait.state).toEqual({ phase: 'waiting', childOperationId: 'original-child-operation', evidence: [reference] });
  return wait;
}

// Events are deliberately supplied here: these tests establish SDK/broker/checkpoint behavior,
// not native source authority, real child completion, or the core's pending-Wait gate.
it('installed SDK collaboration policy keeps original handles and artifact identity across broker reopen', async () => {
  const f = await fixture();
  const lease = await f.prepare();
  expect(lease.binding.artifact.identity.name).toBe('example.collaboration-policy:host:varin.agent.policy@3:fixed-source-collaboration');
  const wait = await waitingCheckpoint(lease);
  const binding = lease.binding.artifact.identity;
  lease.release();
  await f.runtime.stop();
  // Reopening uses the selected immutable installed package, not live source-folder contents.
  await fs.writeFile(path.join(f.source, 'host.cjs'), "throw new Error('uninstalled source changes must not execute');\n");
  const reopened = await f.open();
  const resumed = await f.prepare(reopened);
  expect(resumed.binding.artifact.identity).toEqual(binding);
  // Native core, not this fixture, decides when this event may reach the inner policy.
  const answer = await decide(resumed, graph('wait-action', 'wait-child', accepted('original-observation-operation', 'awaiting_child')), wait.state);
  expect(answer.action).toEqual({ kind: 'request_model_with_evidence', evidence: [reference] });
  expect(answer.state).toEqual({ phase: 'answer', childOperationId: 'original-child-operation', evidence: [reference] });
  expect((await decide(resumed, { kind: 'model_completed', reason: 'stop', tool_calls: 0 }, answer.state)).action).toEqual({ kind: 'complete' });
});

it('installed policy does not redispatch a restored waiting phase and rejects a nonaccepted dispatch', async () => {
  const f = await fixture(); const lease = await f.prepare();
  const wait = await waitingCheckpoint(lease);
  expect((await decide(lease, { kind: 'started' }, wait.state)).action.kind).toBe('fail');
  const dispatch = await decide(lease, { kind: 'started' });
  const failed = await decide(lease, graph('dispatch-action', 'dispatch', { kind: 'result', outcome: 'failed', effect: 'none', output: reference }), dispatch.state);
  expect(failed.action).toEqual({ kind: 'fail', reason: 'Child dispatch was not durably accepted' });
  expect(failed.state).toEqual(dispatch.state);
});

it('installed policy settles actual parent tool calls and never retries an indeterminate exchange', async () => {
  const f = await fixture(); const lease = await f.prepare();
  const wait = await waitingCheckpoint(lease);
  const answer = await decide(lease, graph('wait-action', 'wait-child', accepted('observation', 'awaiting_child')), wait.state);
  expect((await decide(lease, { kind: 'model_completed', reason: 'tool_calls', tool_calls: 1 }, answer.state)).action).toEqual({ kind: 'execute_tools' });
  expect((await decide(lease, { kind: 'tools_completed', results: [{ request_id: 'real-request', call_id: 'real-call',
    completion: { kind: 'result', outcome: 'succeeded', effect: 'none', content: {} } }] }, answer.state)).action)
    .toEqual({ kind: 'request_model_with_evidence', evidence: [reference] });
  expect((await decide(lease, { kind: 'tools_completed', results: [{ request_id: 'real-request', call_id: 'real-call',
    completion: { kind: 'result', outcome: 'indeterminate', effect: 'unknown', content: null } }] }, answer.state)).action.kind).toBe('fail');
});
