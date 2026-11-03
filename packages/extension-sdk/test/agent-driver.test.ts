import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { DriverRunInput, JsonValue } from '@varin/extension-contract';
import { provideAgentDriver, type VarinAgentDriverContext, type VarinHostServiceHandler } from '../src/index.js';
import { runHostExtensionConformance } from '../src/testing.js';

const input = (overrides: Partial<DriverRunInput> = {}): DriverRunInput => ({ runId: 'run-original', epoch: 2, mode: 'start',
  history: [{ id: 'user-original', provenance: { kind: 'user_instruction', input_id: 'input-original' }, content: { kind: 'text', text: 'Find evidence' }, opaque: null }],
  tools: [], models: [{ capabilityId: 'primary', status: 'available' }], checkpoint: null, receipts: [], ...overrides });
const json = (value: unknown) => value as JsonValue;
const usage = { measurement: 'missing', input_tokens: null, output_tokens: null, cached_input_tokens: null,
  cache_write_tokens: null, reasoning_tokens: null, raw: null, pricing_version: null };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('SDK methods are bound to each live service invocation, not activation or a mutable current Run', async () => {
  await runHostExtensionConformance({ extensionId: 'review.driver', dependencies: [], activation: async context => {
    let handler!: VarinHostServiceHandler;
    context.services.provide = (_descriptor, implementation) => { handler = implementation; };
    const held: VarinAgentDriverContext[] = [];
    const config = { branches: 2 };
    provideAgentDriver(context, { identity: { name: 'independent', version: '1' }, configuration: config,
      modelRoles: [], recovery: 'none', checkpointSchema: null,
      async run(value, invocation, configuration) {
        held.push(invocation);
        assert.ok(Object.isFrozen(value.history)); assert.ok(Object.isFrozen(configuration));
        assert.deepEqual(configuration, { branches: 2 });
        const receipt = await invocation.driver.receipt({ id: value.runId, kind: 'delivery' });
        assert.deepEqual(receipt, { kind: 'delivery', id: value.runId, historyId: value.runId });
        return { kind: 'complete' };
      },
    });
    config.branches = 9;
    const call = (runId: string) => ({ callId: `call:${runId}`, signal: new AbortController().signal,
      capabilities: { async call(capability: string, method: string, params: JsonValue) {
        assert.equal(capability, 'runtime.driver'); assert.equal(method, 'receipt');
        assert.deepEqual(params, { id: runId, kind: 'delivery' });
        return { kind: 'delivery', id: runId, historyId: runId };
      } } });
    await Promise.all(['a', 'b'].map(runId => handler.run!([json(input({ runId }))], call(runId))));
    assert.equal(held.length, 2);
    await assert.rejects(held[0]!.driver.receipt({ id: 'a', kind: 'delivery' }), /completed/);
  } });
});

test('checkpoint resume is explicit, schema-bound, and never silently starts a nonrecoverable algorithm', async () => {
  await runHostExtensionConformance({ extensionId: 'review.recovery', dependencies: [], activation: async context => {
    let handler!: VarinHostServiceHandler; let starts = 0; let resumes = 0;
    context.services.provide = (_descriptor, implementation) => { handler = implementation; };
    const base = { identity: { name: 'resume', version: '1' }, configuration: null, modelRoles: [] as [],
      run() { starts++; return { kind: 'complete' as const }; } };
    const call = { callId: 'resume', signal: new AbortController().signal, capabilities: context.capabilities };
    const resumed = input({ mode: 'resume', checkpoint: { revision: 1, schema: 'state-v1', state: { phase: 'joined' }, operations: ['model:proposal'] } });
    provideAgentDriver(context, { ...base, recovery: 'none', checkpointSchema: null });
    await assert.rejects(async () => handler.run!([json(resumed)], call), /cannot resume/);
    provideAgentDriver(context, { ...base, recovery: 'checkpoint', checkpointSchema: 'state-v1',
      resume(value) { resumes++; assert.ok(Object.isFrozen(value.checkpoint!.state)); return { kind: 'complete' }; } });
    await handler.run!([json(resumed)], call);
    await assert.rejects(async () => handler.run!([json({ ...resumed, checkpoint: { ...resumed.checkpoint, schema: 'state-v2' } })], call), /cannot resume/);
    assert.equal(starts, 0); assert.equal(resumes, 1);
  } });
});

test('a returned tool receipt is not discarded just because cancellation intent arrived while awaiting it', async () => {
  await runHostExtensionConformance({ extensionId: 'review.stop', dependencies: [], activation: async context => {
    let handler!: VarinHostServiceHandler; const abort = new AbortController();
    context.services.provide = (_descriptor, implementation) => { handler = implementation; };
    provideAgentDriver(context, { identity: { name: 'stop', version: '1' }, configuration: null, modelRoles: [], recovery: 'none', checkpointSchema: null,
      async run(_input, invocation) {
        const receipt = await invocation.driver.tool({ id: 'read', name: 'read', arguments: {} });
        assert.equal(receipt.executorStopped, false);
        await assert.rejects(invocation.driver.deliver({ id: 'answer', text: 'not admitted' }), { name: 'AbortError' });
        return { kind: 'pause', reason: 'Stop was requested; original owner must reconcile work' };
      } });
    const outcome = await handler.run!([json(input())], { callId: 'stop', signal: abort.signal,
      capabilities: { async call() { abort.abort(); return { id: 'read', operationId: 'operation', executorStopped: false,
        completion: { kind: 'job_accepted', operation_id: 'operation', phase: 'running', effect: 'dispatched', lifetime: 'run' } }; } } });
    assert.equal((outcome as { kind: string }).kind, 'pause');
  } });
});

test('context uses the original Inbox capability and branch cancel preserves intent separately from actual work receipt', async () => {
  await runHostExtensionConformance({ extensionId: 'review.branch-cancel', dependencies: [], activation: async context => {
    let handler!: VarinHostServiceHandler; const abort = new AbortController();
    context.services.provide = (_descriptor, implementation) => { handler = implementation; };
    const originalReceipt = { kind: 'tool', id: 'branch-read', operationId: 'original-operation', phase: 'running', receipt: null };
    const calls: Array<{ method: string; params: JsonValue }> = [];
    provideAgentDriver(context, { identity: { name: 'branch-cancel', version: '1' }, configuration: null,
      modelRoles: [], recovery: 'none', checkpointSchema: null,
      async run(_input, invocation) {
        const refreshed = await invocation.driver.context();
        assert.deepEqual(refreshed.inputIds, ['new-input']); assert.equal(refreshed.activating, true);
        assert.equal(refreshed.history[0]!.id, 'new-message');
        assert.deepEqual(refreshed.tools, []);
        const cancellation = await invocation.driver.cancel({ kind: 'tool', id: 'branch-read' });
        assert.equal(cancellation.requested, true);
        assert.deepEqual(cancellation.receipt, originalReceipt);
        assert.equal(cancellation.receipt?.kind === 'tool' && cancellation.receipt.phase, 'running');
        // The stop signal arrived while this already-admitted cancel was awaiting its receipt.
        await assert.rejects(invocation.driver.context(), { name: 'AbortError' });
        return { kind: 'pause', reason: 'Original owner still has running work' };
      } });
    await handler.run!([json(input())], { callId: 'branch-cancel', signal: abort.signal,
      capabilities: { async call(capability, method, params) {
        assert.equal(capability, 'runtime.driver'); calls.push({ method, params });
        if (method === 'context') return { history: [{ id: 'new-message', provenance: { kind: 'user_instruction', input_id: 'new-input' },
          content: { kind: 'text', text: 'Revise the request' }, opaque: null }], tools: [], inputIds: ['new-input'], activating: true };
        assert.equal(method, 'cancel'); abort.abort(); return { requested: true, receipt: originalReceipt };
      } } });
    assert.deepEqual(calls, [{ method: 'context', params: {} }, { method: 'cancel', params: { kind: 'tool', id: 'branch-read' } }]);
  } });
});

test('an author can read a baseline, await input, and explicitly refresh context without a polling loop', async () => {
  await runHostExtensionConformance({ extensionId: 'review.event-wait', dependencies: [], activation: async context => {
    let handler!: VarinHostServiceHandler;
    context.services.provide = (_descriptor, implementation) => { handler = implementation; };
    const waiting = deferred<void>(); const inputReady = deferred<JsonValue>();
    const trace: string[] = [];
    provideAgentDriver(context, { identity: { name: 'event-wait', version: '1' }, configuration: null,
      modelRoles: [], recovery: 'none', checkpointSchema: null,
      async run(_input, invocation) {
        const baseline = await invocation.driver.wait({ after: null, work: [] });
        assert.equal(baseline.inputPending, false);
        const event = await invocation.driver.wait({ after: baseline.cursor, work: [] });
        assert.equal(event.inputPending, true); assert.equal(event.cursor, 8);
        const refreshed = await invocation.driver.context();
        assert.deepEqual(refreshed.inputIds, ['delivered-input']);
        return { kind: 'complete' };
      } });
    const running = handler.run!([json(input())], { callId: 'event-wait', signal: new AbortController().signal,
      capabilities: { async call(capability, method, params) {
        assert.equal(capability, 'runtime.driver'); trace.push(method);
        if (method === 'wait') {
          const request = params as { after: number | null; work: JsonValue[] };
          assert.deepEqual(request.work, []);
          if (request.after === null) return { cursor: 7, inputPending: false, receipts: [] };
          assert.equal(request.after, 7); waiting.resolve(); return inputReady.promise;
        }
        assert.equal(method, 'context'); assert.deepEqual(params, {});
        return { history: [], tools: [], inputIds: ['delivered-input'], activating: true };
      } } });
    await waiting.promise;
    assert.deepEqual(trace, ['wait', 'wait'], 'waiting does not automatically consume the Inbox');
    inputReady.resolve({ cursor: 8, inputPending: true, receipts: [] });
    assert.deepEqual(await running, { kind: 'complete' });
    assert.deepEqual(trace, ['wait', 'wait', 'context']);
  } });
});

test('the real parallel-driver author code starts both model branches, executes early tools before their join, then delivers synthesis', async () => {
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../../examples/extensions/parallel-driver/build.mjs', import.meta.url))]);
  const parallelExtension = createRequire(import.meta.url)('../../../examples/extensions/parallel-driver/host.cjs').default;
  await runHostExtensionConformance({ extensionId: 'example.parallel-driver', dependencies: [], activation: async context => {
    let handler!: VarinHostServiceHandler;
    context.services.provide = (_descriptor, implementation) => { handler = implementation; };
    await parallelExtension.activate(context);
    const challenge = deferred<JsonValue>(); const toolStarted = deferred<void>(); const toolDone = deferred<JsonValue>();
    const trace: string[] = [];
    const model = (id: string, items: unknown[]) => json({ id, requestId: `request:${id}`, outcome: 'completed', items, usage, finishReason: 'stop', failure: null });
    const outcome = handler.run!([json(input({ tools: [{ name: 'read', version: '1', description: 'Read evidence', schema: {}, output_schema: {},
      metadata: { service_id: 'files', service_version: 1, operation: 'read', completion: 'result' } }] }))], {
      callId: 'parallel', signal: new AbortController().signal, capabilities: { async call(_capability, method, raw) {
        const request = raw as Record<string, JsonValue>; trace.push(method === 'context' ? method : `${method}:${request.id}`);
        if (method === 'model' && request.id === 'proposal') return model('proposal', [{ id: 'call', content: { kind: 'tool_call',
          call: { call_id: 'evidence', name: 'read', schema_version: '1', arguments: { path: 'notes' } } }, opaque: null }]);
        if (method === 'model' && request.id === 'challenge') return challenge.promise;
        if (method === 'tool') { toolStarted.resolve(); return toolDone.promise; }
        if (method === 'context') {
          assert.deepEqual(request, {});
          return json({ history: [...input().history, { id: 'new-message', provenance: { kind: 'user_instruction', input_id: 'new-input' },
            content: { kind: 'text', text: 'Also explain the remaining uncertainty' }, opaque: null }], tools: [], inputIds: ['new-input'], activating: true });
        }
        if (method === 'model' && request.id === 'synthesis') {
          const history = request.history as Array<{ id: string; content: { text: string } }>;
          assert.equal(history[0]!.id, 'user-original'); assert.equal(history.length, 4);
          assert.equal(history[1]!.id, 'new-message');
          assert.match(history[2]!.content.text, /actual evidence/);
          return model('synthesis', [{ id: 'answer-text', content: { kind: 'text', text: 'Evidence-backed answer' }, opaque: null }]);
        }
        assert.equal(method, 'deliver'); assert.equal(request.text, 'Evidence-backed answer');
        return { id: 'answer', historyId: 'durable-answer' };
      } },
    });
    await toolStarted.promise;
    assert.deepEqual(trace, ['model:proposal', 'model:challenge', 'tool:proposal:evidence']);
    toolDone.resolve({ id: 'proposal:evidence', operationId: 'original-operation', executorStopped: true,
      completion: { kind: 'result', outcome: 'succeeded', effect: 'none', content: { data: { fact: 'actual evidence' }, parts: [] } } });
    await Promise.resolve(); assert.equal(trace.some(entry => entry === 'model:synthesis'), false);
    challenge.resolve(model('challenge', [{ id: 'challenge-text', content: { kind: 'text', text: 'An independent counterexample' }, opaque: null }]));
    assert.deepEqual(await outcome, { kind: 'complete' });
    assert.deepEqual(trace.slice(-3), ['context', 'model:synthesis', 'deliver:answer']);
  } });
});
