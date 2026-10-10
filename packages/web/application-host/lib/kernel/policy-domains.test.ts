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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-policy-domains-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'domain-policy');
  await fs.mkdir(source);
  for (const file of ['package.json', 'varin.extension.json']) {
    await fs.copyFile(path.join(repository, 'examples/extensions/domain-policy', file), path.join(source, file));
  }
  await build({ entryPoints: [path.join(repository, 'examples/extensions/domain-policy/host.ts')], bundle: true,
    platform: 'node', format: 'cjs', outfile: path.join(source, 'host.cjs'),
    alias: { '@varin/extension-sdk': path.join(repository, 'packages/extension-sdk/dist/index.js') } });
  const open = async () => {
    const runtime = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: buildVersion,
      brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
    await runtime.start(); cleanups.push(() => runtime.stop()); return runtime;
  };
  const runtime = await open();
  await runtime.installOrStage({ expectedRevision: (await runtime.state()).catalog.revision,
    source: { kind: 'local', display: 'Plan, question and process example', specifier: source } });
  await runtime.upsertServiceRoutingRule({ expectedRevision: (await runtime.routing.read()).document.revision,
    rule: { serviceId: 'varin.agent.policy', version: 3, providerKey: 'example.domain-policy:host:varin.agent.policy@3',
      scope: { sessionId: 'main-thread' }, allowFallback: false } });
  const prepare = async (owner = runtime) => {
    const lease = await createAgentPolicy(owner)({ sessionId: 'main-thread' });
    if (!lease) throw new Error('Installed example was not selected');
    cleanups.push(async () => { lease.release(); }); return lease;
  };
  return { runtime, source, open, prepare };
}
function decide(lease: AgentPolicyLease, event: VarinAgentPolicyInput['event'], state: JsonValue = null) {
  return lease.decide({ view: { run_id: 'run', state: 'runnable', history_count: 1,
    history_head_id: 'real-input-fixture', pending_tool_calls: 0, model_capabilities: [] }, event, state }, new AbortController().signal);
}
const accepted = (operationId: string, phase: string, effect: 'none' | 'dispatched' = 'none'): VarinAgentPolicyToolCompletion => ({
  kind: 'job_accepted', operation_id: operationId, phase, effect, lifetime: 'thread',
});
function completed(lease: AgentPolicyLease, before: VarinAgentPolicyDecision, tool: string, completion: VarinAgentPolicyToolCompletion) {
  expect(before.action).toMatchObject({ kind: 'tool_graph', nodes: [{ id: tool, call: { name: tool } }] });
  return decide(lease, { kind: 'tool_graph_completed', action_id: `${tool}-action`, receipts: [{ node_id: tool, completion }] }, before.state);
}
async function readResult(lease: AgentPolicyLease, before: VarinAgentPolicyDecision, tool: string, content: JsonValue) {
  const reference = { action_id: `${tool}-action`, node_id: tool, content_ref: `${tool}-original-content` };
  let next = await completed(lease, before, tool, { kind: 'result', outcome: 'succeeded', effect: 'none', output: reference });
  const bytes = [...new TextEncoder().encode(JSON.stringify(content))];
  // The actual broker transports typed result bytes; split inside a Unicode code point when present.
  const multibyte = bytes.findIndex(byte => byte >= 0xc0);
  const split = multibyte < 0 ? Math.ceil(bytes.length / 2) : multibyte + 1;
  const chunks = [bytes.slice(0, split), bytes.slice(split)];
  for (const [index, chunk] of chunks.entries()) {
    expect(next.action).toEqual({ kind: 'read_result', reference, index });
    next = await decide(lease, { kind: 'result_chunk', reference, index, total_chunks: chunks.length, total_bytes: bytes.length, bytes: chunk }, next.state);
  }
  return next;
}
async function question(lease: AgentPolicyLease) {
  const read = await decide(lease, { kind: 'started' });
  const update = await readResult(lease, read, 'todo', { status: 'ready', plan: { ref: 'prior-plan', content: '原计划' } });
  expect(update.action).toMatchObject({ kind: 'tool_graph', nodes: [{ call: { name: 'todo', arguments: { action: 'update', expectedRef: 'prior-plan' } } }] });
  return completed(lease, update, 'todo', { kind: 'result', outcome: 'succeeded', effect: 'confirmed',
    output: { action_id: 'update-action', node_id: 'todo', content_ref: 'update-receipt' } });
}

// Committed domain events are supplied fixtures here. These checks establish the ordinary installer,
// immutable broker artifact, SDK transport and policy consumer logic, not Catalog Wait/receipt truth.
it('installed domain policy resumes its saved question, reads genuine result shapes, and keeps original process handles', async () => {
  const f = await fixture(); const first = await f.prepare();
  const ask = await question(first); const identity = first.binding.artifact.identity;
  first.release(); await f.runtime.stop();
  await fs.writeFile(path.join(f.source, 'host.cjs'), "throw new Error('uninstalled source must not be used');\n");
  const reopened = await f.open(); const lease = await f.prepare(reopened);
  expect(lease.binding.artifact.identity).toEqual(identity);
  const status = await completed(lease, ask, 'ask_user', accepted('original-question', 'awaiting_user'));
  expect(status.action).toMatchObject({ kind: 'tool_graph', nodes: [{ call: { name: 'question_status', arguments: { operationId: 'original-question' } } }] });
  const spawn = await readResult(lease, status, 'question_status', { operationId: 'original-question', status: 'answered', answer: 'run', historyId: 'original-answer' });
  expect(spawn.action).toMatchObject({ kind: 'tool_graph', nodes: [{ call: { name: 'process_spawn', arguments: { command: 'node', mode: 'pty', cwd: '' } } }] });
  const resize = await completed(lease, spawn, 'process_spawn', accepted('original-process', 'running', 'dispatched'));
  expect(resize.action).toMatchObject({ kind: 'tool_graph', nodes: [{ call: { name: 'process_resize', arguments: { processId: 'original-process', cols: 111, rows: 41 } } }] });
  const applied = (name: string): Extract<VarinAgentPolicyToolCompletion, { kind: 'result' }> => ({ kind: 'result', outcome: 'succeeded', effect: 'confirmed',
    output: { action_id: `${name}-action`, node_id: name, content_ref: `${name}-receipt` } });
  const write = await completed(lease, resize, 'process_resize', applied('process_resize'));
  expect(write.action).toMatchObject({ kind: 'tool_graph', nodes: [{ call: { name: 'process_write', arguments: { processId: 'original-process', text: 'fixed policy input\n' } } }] });
  const uncertain = await completed(lease, write, 'process_write', { ...applied('process_write'), kind: 'result', outcome: 'indeterminate', effect: 'unknown' });
  expect(uncertain.action.kind).toBe('fail');
  const wait = await completed(lease, write, 'process_write', applied('process_write'));
  expect(wait.action).toMatchObject({ kind: 'tool_graph', nodes: [{ call: { name: 'wait_process', arguments: { processId: 'original-process' } } }] });
  const inspect = await completed(lease, wait, 'wait_process', accepted('original-observer', 'awaiting_process'));
  expect(inspect.action).toMatchObject({ kind: 'tool_graph', nodes: [{ call: { name: 'process_inspect', arguments: { processId: 'original-process' } } }] });
  const delivery = await readResult(lease, inspect, 'process_inspect', { status: 'exited', exitCode: 0 });
  expect(delivery.action).toEqual({ kind: 'deliver', text: 'The original process owner reports that the fixed probe exited with code 0.' });
  const pause = await decide(lease, { kind: 'delivered', action_id: 'delivery', item_id: 'delivery-history' }, delivery.state);
  expect(pause.action.kind).toBe('pause');
  expect((await decide(lease, { kind: 'started' }, pause.state)).action.kind).toBe('fail');
  const final = await decide(lease, { kind: 'resumed', action_id: 'original-pause', wait_id: 'original-wait' }, pause.state);
  expect(final.action.kind).toBe('deliver');
  expect((await decide(lease, { kind: 'delivered', action_id: 'final', item_id: 'final-history' }, final.state)).action).toEqual({ kind: 'complete' });
});

it.each([{ status: 'cancelled' }, { status: 'answered', answer: 'run; unexpected shell command', historyId: 'answer' }])(
  'installed policy does not start a process for cancelled or nonselected answers: $status', async result => {
    const f = await fixture(); const lease = await f.prepare(); const ask = await question(lease);
    const status = await completed(lease, ask, 'ask_user', accepted('original-question', 'awaiting_user'));
    const delivery = await readResult(lease, status, 'question_status', { operationId: 'original-question', ...result });
    expect(delivery.action.kind).toBe('deliver');
    expect((await decide(lease, { kind: 'delivered', action_id: 'cancelled', item_id: 'cancelled-history' }, delivery.state)).action).toEqual({ kind: 'complete' });
  },
);

it('installed policy never retries a failed or uncertain plan mutation', async () => {
  const f = await fixture(); const lease = await f.prepare();
  const read = await decide(lease, { kind: 'started' });
  const update = await readResult(lease, read, 'todo', { status: 'ready', plan: null });
  for (const outcome of ['failed', 'indeterminate'] as const) {
    const next = await completed(lease, update, 'todo', { kind: 'result', outcome, effect: outcome === 'failed' ? 'none' : 'unknown',
      output: { action_id: 'update-action', node_id: 'todo', content_ref: 'actual-receipt' } });
    expect(next.action.kind).toBe('fail'); expect(next.state).toEqual(update.state);
  }
});
