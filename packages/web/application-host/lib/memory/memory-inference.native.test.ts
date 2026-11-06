import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { createKernelClient } from '../kernel/kernel-client.js';
import type { MemoryWorkStatus, Operation } from '../kernel/protocol.generated.js';
import { ExistingHostCredentialOwner } from '../kernel/credential-owner.js';
import { guardProviderReply } from '../kernel/provider-response.test-helper.js';
import { createMemoryInference } from './memory-inference.js';
import { createDecisionInference } from '../knowledge/semantic/decision-inference.js';
import { createInferenceRequests, type InferenceRequestsOptions } from '../knowledge/semantic/inference-requests.js';

// Exercise the Host consumer against the real Catalog and native HTTP executor. The provider
// supplies controlled bytes only; it does not calculate admission, retries, receipts or recovery.
const buildVersion = (JSON.parse(await readFile(new URL('../../../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Memory inference cleanup failed');
});
const scopeId = 'bot:memory-review';
const text = '{"memories":[{"content":"Keep original recovery evidence"}]}';
const decisionInput = { purpose: 'memory-organization' as const, goal: 'Keep useful evidence',
  materials: [{ id: 'u0', text: 'Original source' }], questions: [{ id: 'u0', kind: 'judge' as const, instructions: 'Keep this evidence?' }] };
function complete(response: ServerResponse, finish: 'stop' | 'length') {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({
    type: finish === 'stop' ? 'response.completed' : 'response.incomplete',
    response: { id: 'original-provider-response', status: finish === 'stop' ? 'completed' : 'incomplete',
      ...(finish === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      output: [{ id: 'original-item', type: 'message', role: 'assistant', content: [{ type: 'output_text', text }], originalRaw: { preserved: true } }],
      usage: { input_tokens: 19, output_tokens: 7 },
    },
  })}\n\n`);
}
async function fixture(classifier = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-memory-inference-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let finish: 'stop' | 'length' | 'hold' = 'stop';
  let decisionAnswer = 1;
  const decisionRequests: unknown[] = [];
  const requests: Array<{ body: unknown; authorization: string | undefined; response: ServerResponse }> = [];
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', guardProviderReply(response, () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (request.url === '/systemone') {
        decisionRequests.push(body);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ answers: { u0: { type: 'noul', noul: decisionAnswer } }, usage: { input_tokens: 11, output_tokens: 1 } }));
        return;
      }
      requests.push({ body, authorization: request.headers.authorization, response });
      if (finish === 'hold') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"type":"response.output_text.delta","item_id":"original-item","delta":"partial evidence"}\n\n');
      } else complete(response, finish);
    }));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  cleanups.push(async () => {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
  });
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback provider');
  const endpoint = `http://127.0.0.1:${address.port}/responses`;
  const configuration = { providerId: 'memory-fixture', providerFamily: 'openai-responses', model: 'original-model',
    endpoint, credentialEnvironment: null, allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 64 };
  const credential = () => new ExistingHostCredentialOwner({ providerId: configuration.providerId, providerFamily: configuration.providerFamily, endpoint,
    currentScope: async () => ({ reference: 'fixture', authority: 'fixture', account: 'original-account', generation: 1 }),
    runtime: { getAuth: async () => ({ auth: { apiKey: 'fixture-key-not-a-real-secret' } }) },
  });
  let disabled = false;
  let allowBinding = true;
  async function open() {
    const kernel = createKernelClient({ hostId: 'memory-inference-review', storageRoot: root, buildVersion,
      kernelPath: process.env.VARIN_TEST_KERNEL_PATH!, allowCargoDevRunner: false });
    const runtime = new AgentRuntimeClient(kernel);
    await kernel.start();
    await kernel.agentRuntimeRequest('runtime.bot.gate.publish', { botId: 'memory-review', profileRevision: 1, activityOperationId: null, permitted: true });
    const models = {
      resolveModel: async () => { expect(allowBinding).toBe(true); return { configuration, credentialOwner: credential(), acceptsImages: false }; },
      rebindModel: async () => { expect(allowBinding).toBe(true); return credential(); },
    } satisfies Parameters<typeof createMemoryInference>[0]['models'];
    const scope = await credential().scope();
    const requestOptions: InferenceRequestsOptions = { kernel, runtime,
      egress: { prepare: async () => ({ fetch, policy: { mode: 'direct', version: 1, noProxy: [], source: 'none', fingerprint: 'loopback-fixture' } }) } };
    const requestOwner = createInferenceRequests(requestOptions);
    const decision = createDecisionInference({ resolveDecisionBinding: async () => ({
      providerId: 'classifier', modelId: 'original-classifier', baseUrl: endpoint.replace('/responses', ''),
      requestUrl: endpoint.replace('/responses', '/systemone'), api: 'typesafe-system-one', configurationId: 'original-classifier-configuration',
      credentialRef: 'fixture', credentialScope: scope, routes: [{ requestUrl: endpoint.replace('/responses', '/systemone'), requestKind: 'model_compute' }],
      assertAvailable: async () => {}, currentScope: async () => scope, getAuth: async () => ({ auth: { apiKey: 'fixture-classifier-key' } }),
    }) }, async () => ({ harness: { fastDecision: { default: { protocol: 'typed-classifier', providerId: 'classifier', modelId: 'original-classifier' } } } }), requestOptions, requestOwner);
    const inference = createMemoryInference({ kernel, runtime, models,
      authority: { readGlobalInferenceSettings: async () => ({ harness: { models: { memoryOrganizer: { enabled: !disabled } } } }),
        selectedModel: async () => { throw new Error('Accepted work must use its frozen binding'); } },
      decision: { captureDecision: async purpose => { expect(classifier && allowBinding).toBe(true); return decision.capture(purpose); } },
      validateScope: async id => { expect(id).toBe(scopeId); }, canExecuteScope: async () => true,
    });
    let closed = false;
    const close = async (cancel = true) => {
      if (closed) return;
      closed = true;
      try { await inference.close(cancel ? [scopeId] : []); } finally { decision.close(); await requestOwner.close(); await kernel.close(); }
    };
    cleanups.push(close);
    return { kernel, inference, close };
  }
  const connection = await open();
  const binding = await connection.inference.bind({ providerId: configuration.providerId, modelId: configuration.model });
  const decisionStatus = classifier ? await connection.inference.describeDecision() : null;
  const input = (key: string, mode: 'automatic' | 'selection' = 'selection', retryOf?: string) => ({ key, scopeId, mode,
    spans: [{ kind: 'history-item' as const, id: 'source', threadId: 'thread', branchId: 'branch', headId: 'source', revision: 'original', start: 0, end: 10 }],
    recipe: { binding, decisionStatus, text: 'Frozen source text' }, ...(retryOf ? { retryOf } : {}),
  });
  return { root, connection, input, requests, decisionRequests, open,
    decisionAnswer: (value: number) => { decisionAnswer = value; },
    finish: (value: typeof finish) => { finish = value; }, disable: () => { disabled = true; }, forbidRebinding: () => { allowBinding = false; } };
}

it.each(['automatic', 'selection'] as const)('%s work reopens original provider output and decisions without another request or current binding', async mode => {
  const f = await fixture(mode === 'automatic');
  const { inference } = f.connection;
  let work = await inference.admit(f.input('original', mode));
  if (mode === 'automatic') {
    work = await inference.decide(work, decisionInput, work.recipe.decisionStatus);
    expect(work.decision).toEqual([0]);
    expect(f.decisionRequests).toHaveLength(1);
  }
  const [first, concurrent] = await Promise.all([inference.generate(work, 'Original instructions', 'Original source'), inference.generate(work, 'Original instructions', 'Original source')]);
  expect(first.text).toBe(text); expect(concurrent).toEqual(first);
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toMatchObject({ authorization: 'Bearer fixture-key-not-a-real-secret', body: { model: 'original-model' } });
  expect(first.work.inference.find(op => (op.intent as { binding?: { purpose: string } }).binding?.purpose === 'memory-organizer')).toMatchObject({ outcome: 'succeeded', result: { value: {
    receipt: { localExecutorStopped: true, usage: { inputTokens: 19, outputTokens: 7 } },
    response: { providerOutput: { finishReason: 'stop' } },
  } } });
  expect(JSON.stringify(first.work)).not.toContain('fixture-key-not-a-real-secret');
  await f.connection.close(false); f.forbidRebinding();
  const reopened = await f.open();
  const restored = await reopened.inference.find('original');
  expect(restored).toMatchObject({ recipe: work.recipe, claims: work.claims, decision: work.decision, inference: first.work.inference });
  expect((await reopened.inference.generate(restored!, 'Changed caller text', 'Not a new request')).text).toBe(text);
  expect(f.requests).toHaveLength(1);
  expect(f.decisionRequests).toHaveLength(mode === 'automatic' ? 1 : 0);
  await reopened.inference.finish(restored!);
  expect((await reopened.inference.read(work.workId)).consumed).toBe(true);
  f.disable();
  await expect(reopened.inference.generate(restored!, '', '')).rejects.toMatchObject({ code: 'memory-organizer-disabled' });
  expect(f.requests).toHaveLength(1);
});

it('recovers an unpublished empty decision from original classifier receipts after Host restart', async () => {
  const f = await fixture(true); f.decisionAnswer(0);
  const { inference, kernel } = f.connection;
  const work = await inference.admit(f.input('decision', 'automatic'));
  const request = kernel.agentRuntimeRequest.bind(kernel);
  const failPublication = vi.spyOn(kernel, 'agentRuntimeRequest').mockImplementation(async (method, params, ...rest) => {
    if (method === 'runtime.memory_work.update' && (params as { action: { kind: string } }).action.kind === 'decision') throw new Error('Host stopped before decision publication');
    return request(method, params, ...rest);
  });
  try { await expect(inference.decide(work, decisionInput, work.recipe.decisionStatus)).rejects.toThrow('Host stopped before decision publication'); }
  finally { failPublication.mockRestore(); }
  const original = await inference.read(work.workId);
  expect(original.decision).toBeNull();
  expect(original.inference).toMatchObject([{ outcome: 'succeeded', result: { value: { receipt: { usage: { inputTokens: 11 } } } } }]);
  await f.connection.close(false); f.forbidRebinding();
  const reopened = await f.open();
  const restored = await reopened.inference.decide(await reopened.inference.read(work.workId), decisionInput, work.recipe.decisionStatus);
  expect(restored.decision).toEqual([]);
  expect(restored.inference).toEqual(original.inference);
  expect(f.decisionRequests).toHaveLength(1);
  expect(f.requests).toHaveLength(0);
  await reopened.inference.finish(restored);
});

it('retains truncated output and usage until a distinct explicit linked retry', async () => {
  const f = await fixture(); const { inference } = f.connection;
  f.finish('length');
  const work = await inference.admit(f.input('truncated'));
  await expect(inference.generate(work, 'Instructions', 'Source')).rejects.toMatchObject({ retryDisposition: 'new_attempt' });
  const original = await inference.read(work.workId);
  expect(original.inference[0]).toMatchObject({ outcome: 'failed', result: { value: {
    receipt: { providerCompleted: true, localExecutorStopped: true, usage: { inputTokens: 19, outputTokens: 7 } },
    response: { text: null, providerOutput: { finishReason: 'length' } },
  } } });
  const observed = await inference.admit(f.input('truncated'));
  await expect(inference.generate(observed, 'Instructions', 'Source')).rejects.toMatchObject({ retryDisposition: 'new_attempt' });
  expect(f.requests).toHaveLength(1);
  f.finish('stop');
  const retry = await inference.admit(f.input('retry', 'selection', 'truncated'));
  expect((await inference.generate(retry, 'Instructions', 'Source')).text).toBe(text);
  expect(f.requests).toHaveLength(2);
  expect((await inference.read(work.workId)).inference).toEqual(original.inference);
  expect(await f.connection.kernel.agentRuntimeRequest('runtime.operation.inspect', { operationId: retry.workId })).toMatchObject({ intent: { retryOf: work.workId } });
});

it('suspension drains the actual native request even when the large recipe cannot be read', async () => {
  const f = await fixture(); const { inference, kernel } = f.connection;
  f.finish('hold');
  const work = await inference.admit(f.input('held'));
  const generation = inference.generate(work, 'Instructions', 'Source');
  const rejected = generation.then(() => { throw new Error('Cancelled memory generation succeeded'); }, error => error);
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  const operation = await kernel.agentRuntimeRequest<Operation, 'runtime.operation.inspect'>('runtime.operation.inspect', { operationId: work.workId });
  const hash = (operation!.intent as { recipeRef: { content_object: string } }).recipeRef.content_object.slice('sha256-'.length);
  const recipePath = path.join(f.root, 'agent-runtime/content/objects', hash.slice(0, 2), hash.slice(2));
  const recipe = await readFile(recipePath); await rm(recipePath);
  try {
    await expect(inference.read(work.workId)).rejects.toThrow();
    // The short status/cancel path must still reach and settle the original executor.
    await inference.suspendScope(scopeId);
  } finally { await writeFile(recipePath, recipe); }
  const stopped = await kernel.agentRuntimeRequest<MemoryWorkStatus, 'runtime.memory_work.status'>('runtime.memory_work.status', { workId: work.workId });
  expect(stopped.inference[0]).toMatchObject({ phase: 'terminal', live: false, receipt: { localExecutorStopped: true } });
  expect(await rejected).toBeInstanceOf(Error);
  expect((await inference.read(work.workId)).inference[0]).toMatchObject({ effect: 'unknown' });
  await vi.waitFor(() => expect(f.requests[0]!.response.destroyed).toBe(true));
  expect(f.requests).toHaveLength(1);
});
