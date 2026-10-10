import { resourceScopeFixture } from './resource-scope.test-helper.js';
import express from 'express';
import request from 'supertest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ThreadIdentity } from '@varin/application-client';
import type { PlanMutationResult } from '@varin/protocol';
import { createKernelClient } from './kernel-client.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { ThreadAdapter, type ThreadModelAuthority } from './thread-adapter.js';
import { ExistingHostCredentialOwner } from './credential-owner.js';
import type { ModelSessionConfiguration, InputSubmitReceipt, InitialContext } from './protocol.generated.js';
import { PlanService } from './plan-service.js';
import { registerThreadRoutes } from './thread-routes.js';
import { registerCommonRequestMiddleware } from '../platform/core-routes.js';
import { openUserKnowledgeStore } from '../harness/recall-tool.js';
import { createPlanOwner, type PlanQuery } from './plan-owner.js';
import { createMemoryOwner } from './memory-owner.js';
import { createThreadContext } from './thread-context.js';
import { createAgentPersonalization } from '../memory/agent-personalization.js';
import { KernelStorageAdapter, createKernelWorkspaceWorkingStateAccess } from './storage-adapter.js';

const repository = path.resolve(import.meta.dirname, '../../../../..');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** Actual authenticated Host routes, Catalog IPC and private TriviumDB worker. */
async function fixture(existingRoot?: string) {
  const kernelPath = process.env.VARIN_TEST_KERNEL_PATH;
  if (!kernelPath) throw new Error('Requires an explicit source-bound VARIN_TEST_KERNEL_PATH');
  const root = existingRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), 'varin-plan-integration-'));
  if (!existingRoot) cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const kernel = createKernelClient({ hostId: 'plan-integration', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  cleanups.push(() => kernel.close());
  const runtime = new AgentRuntimeClient(kernel);
  const store = await openUserKnowledgeStore({ dataDir: root, hostId: 'plan-integration', embedding: null });
  cleanups.push(() => store.close());
  const plans = new PlanService(runtime, async () => store);
  const models: ThreadModelAuthority = {
    resolveModel: async () => { throw new Error('No provider needed for HTTP plan ownership'); },
    rebindModel: async () => { throw new Error('No provider needed for HTTP plan ownership'); },
  };
  const adapter = new ThreadAdapter(runtime, models, async () => { throw new Error('No source needed'); }, () => {}, undefined, undefined, plans);
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  registerThreadRoutes(app, adapter, (req, res, next) => {
    if (req.headers['x-fixture-auth'] !== 'plan-review') { res.status(401).json({ error: 'auth required' }); return; }
    next();
  });
  const post = (method: string, body: object) => request(app).post(`/api/threads/${method}`).set('x-fixture-auth', 'plan-review').send(body);
  const scopeContext: { prepare?: (identity: ThreadIdentity) => Promise<InitialContext> } = {};
  const create = async (key: string, admitted = true, blankFork = true) => {
    const identity = (await post('create', { key }).expect(200)).body as ThreadIdentity;
    if (!admitted) return identity;
    const receipt = await runtime.submit({ key: `scope:${key}`, threadId: identity.threadId, branchId: identity.branchId,
      expectedHead: null, input: { text: 'Establish real main-thread context' }, configuration: {},
      initialContext: scopeContext.prepare ? await scopeContext.prepare(identity) : { effectiveSystemPrompt: 'PLAN_REVIEW_MAIN', instructionSources: ['plan-review'], memoryCheckpoint: 'plan-review:0',
        personalization: { mode: 'agent', threadRole: 'main', sessionId: identity.threadId, projectId: null, revision: 0,
          configurationDigest: 'plan-review', memorySnapshot: { revision: 0, memories: [] },
          originalSections: [{ name: 'preamble', content: 'PLAN_REVIEW_MAIN' }], instructionSources: ['plan-review'] } } });
    await runtime.cancelRun(receipt.run_id);
    if (!blankFork) return identity;
    // A real null-head fork inherits its admitted main scope without inventing a Pi owner.
    return (await post('fork', { ...identity, key: `blank:${key}`, headId: null }).expect(200)).body as ThreadIdentity;
  };
  const read = (identity: ThreadIdentity) => post('plan/read', identity);
  const write = (identity: ThreadIdentity, key: string, expectedHeadId: string | null, expectedRef: string | null, content: string) =>
    post('plan/update', { ...identity, key, expectedHeadId, expectedRef, content });
  const append = async (identity: ThreadIdentity, key: string) => {
    const view = await runtime.planView(identity.branchId);
    const receipt = await runtime.submit({ key, threadId: identity.threadId, branchId: identity.branchId,
      expectedHead: view.headId, input: { text: key }, configuration: {} });
    await runtime.cancelRun(receipt.run_id);
    return (await runtime.planView(identity.branchId)).headId!;
  };
  return { root, app, kernel, runtime, store, plans, adapter, models, scopeContext, post, create, read, write, append };
}

it('HTTP plan routes authenticate, derive Catalog ownership and reject injected owner fields', async () => {
  const f = await fixture(); const a = await f.create('a'); const b = await f.create('b');
  const unadmitted = await f.create('unadmitted', false);
  await f.read(unadmitted).expect(400);
  await f.write(unadmitted, 'no-scope', null, null, 'must not write').expect(400);
  await request(f.app).post('/api/threads/plan/read').send(a).expect(401);
  expect((await f.read(a).expect(200)).body).toMatchObject({ identity: a, headId: null, plan: null });
  await f.read({ ...b, branchId: a.branchId }).expect(400);
  await f.post('plan/read', { ...a, inheritedRef: 'forged-ref' }).expect(400);
  await f.post('plan/update', { ...a, key: 'forged', expectedHeadId: null, expectedRef: null, content: 'forged',
    origin: { kind: 'tool', operationId: 'forged' } }).expect(400);
  expect((await f.read(a).expect(200)).body.plan).toBeNull();
});

it('HTTP exact-ref CAS preserves real empty revisions and original user replay after a later edit', async () => {
  const f = await fixture(); const a = await f.create('cas');
  const first = (await f.write(a, 'first', null, null, '- [ ] First').expect(200)).body as PlanMutationResult;
  const second = (await f.write(a, 'second', null, first.receipt.ref, '').expect(200)).body as PlanMutationResult;
  expect(second.plan).toMatchObject({ content: '', previousRef: first.receipt.ref });
  expect(second.receipt.ref).not.toBe(first.receipt.ref);
  await f.write(a, 'stale', null, first.receipt.ref, 'must not overwrite').expect(409);
  expect((await f.write(a, 'first', null, null, '- [ ] First').expect(200)).body).toEqual(first);
  await f.write(a, 'first', null, null, 'changed intent').expect(400);
  expect((await f.read(a).expect(200)).body.plan).toEqual(second.plan);
});

it('HTTP stale-head writes conflict while an original successful receipt replays after history advances', async () => {
  const f = await fixture(); const a = await f.create('head-cas');
  const first = (await f.write(a, 'before-head', null, null, 'before history').expect(200)).body as PlanMutationResult;
  const head = await f.append(a, 'new-history'); expect(head).toBeTruthy();
  await f.write(a, 'stale-head', null, first.receipt.ref, 'stale').expect(409);
  expect((await f.write(a, 'before-head', null, null, 'before history').expect(200)).body).toEqual(first);
  expect((await f.read(a).expect(200)).body).toMatchObject({ headId: head, plan: first.plan });
});

it('HTTP historical and nested forks resolve actual ancestry instead of the source latest plan', async () => {
  const f = await fixture(); const a = await f.create('historical');
  const h1 = await f.append(a, 'history-1');
  const p1 = (await f.write(a, 'p1', h1, null, 'plan at h1').expect(200)).body as PlanMutationResult;
  const h2 = await f.append(a, 'history-2');
  const p2 = (await f.write(a, 'p2', h2, p1.receipt.ref, 'plan at h2').expect(200)).body as PlanMutationResult;
  const b = (await f.post('fork', { ...a, key: 'fork-h2', headId: h2 }).expect(200)).body as ThreadIdentity;
  expect((await f.read(b).expect(200)).body.plan).toEqual(p2.plan);
  const c = (await f.post('fork', { ...b, key: 'nested-h1', headId: h1 }).expect(200)).body as ThreadIdentity;
  expect((await f.read(c).expect(200)).body.plan).toEqual(p1.plan);
  await f.write(a, 'p3', h2, p2.receipt.ref, 'source later').expect(200);
  expect((await f.read(b).expect(200)).body.plan).toEqual(p2.plan);
  expect((await f.read(c).expect(200)).body.plan).toEqual(p1.plan);
  const other = await f.create('unrelated'); const foreignHead = await f.append(other, 'foreign-history');
  await f.post('fork', { ...a, key: 'foreign-cut', headId: foreignHead }).expect(400);
});

it('HTTP fixed null capture survives retry and a later source plan without falling back to latest', async () => {
  const f = await fixture(); const a = await f.create('null-capture');
  const input = { ...a, key: 'empty-fork', headId: null };
  const b = (await f.post('fork', input).expect(200)).body as ThreadIdentity;
  await f.write(a, 'source-created-later', null, null, 'late source plan').expect(200);
  expect((await f.post('fork', input).expect(200)).body).toEqual(b);
  expect((await f.read(b).expect(200)).body.plan).toBeNull();
});

function gate() {
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  return { release, reached, pause: async () => { entered(); await waiting; } };
}

it('head advance after Catalog admission preserves the validated history anchor without claiming cross-owner atomicity', async () => {
  const f = await fixture(); const a = await f.create('head-after-admission'); const g = gate();
  const mutate = f.store.mutatePlan.bind(f.store);
  f.store.mutatePlan = async input => { if (input.origin.kind === 'user' && input.origin.key === 'gated') await g.pause(); return mutate(input); };
  const pending = f.write(a, 'gated', null, null, 'admitted before new input').then(response => response);
  try {
    await Promise.race([g.reached, pending.then(response => { throw new Error(`HTTP request ended before review gate: ${response.status}`); })]);
    const head = await f.append(a, 'history-after-plan-admission');
    g.release();
    const saved = await pending; expect(saved.status).toBe(200);
    expect(saved.body.plan.sourceHeadId).toBeNull();
    expect((await f.read(a).expect(200)).body).toMatchObject({ headId: head, plan: saved.body.plan });
  } finally { g.release(); await pending; }
});

it('a plan change after Catalog admission still loses the owner CAS and cannot overwrite the newer user plan', async () => {
  const f = await fixture(); const a = await f.create('plan-after-admission'); const g = gate();
  const mutate = f.store.mutatePlan.bind(f.store);
  f.store.mutatePlan = async input => { if (input.origin.kind === 'user' && input.origin.key === 'gated') await g.pause(); return mutate(input); };
  const pending = f.write(a, 'gated', null, null, 'older draft').then(response => response);
  try {
    await Promise.race([g.reached, pending.then(response => { throw new Error(`HTTP request ended before review gate: ${response.status}`); })]);
    const head = await f.append(a, 'new-input');
    const newer = (await f.write(a, 'newer', head, null, 'newer user plan').expect(200)).body as PlanMutationResult;
    g.release(); expect((await pending).status).toBe(409);
    expect((await f.read(a).expect(200)).body.plan).toEqual(newer.plan);
  } finally { g.release(); await pending; }
});

it('fork captures before branch creation, releases Catalog during owner I/O and keeps the captured revision', async () => {
  const f = await fixture(); const a = await f.create('capture-interleave');
  const p1 = (await f.write(a, 'p1', null, null, 'captured first').expect(200)).body as PlanMutationResult;
  const g = gate(); const capture = f.store.capturePlanFork.bind(f.store);
  f.store.capturePlanFork = async input => { const result = await capture(input); await g.pause(); return result; };
  const pending = f.post('fork', { ...a, key: 'capture-paused', headId: null }).then(response => response);
  try {
    await Promise.race([g.reached, pending.then(response => { throw new Error(`HTTP request ended before review gate: ${response.status}`); })]);
    // A held Host callback must not hold the Rust Catalog lock.
    await f.runtime.status();
    await f.write(a, 'p2', null, p1.receipt.ref, 'source changed during fork').expect(200);
    g.release(); const created = await pending; expect(created.status).toBe(200);
    expect((await f.read(created.body as ThreadIdentity).expect(200)).body.plan).toEqual(p1.plan);
  } finally { g.release(); await pending; }
});

it('a failed fork capture cannot poison an existing real root branch', async () => {
  const f = await fixture(); const source = await f.create('orphan-source'); const root = await f.create('existing-root', true, false);
  const rootHead = (await f.runtime.planView(root.branchId)).headId;
  const before = (await f.write(root, 'root-plan', rootHead, null, 'existing root plan').expect(200)).body as PlanMutationResult;
  await f.plans.capture(source, null, root.branchId);
  await expect(f.runtime.forkBranch(source.branchId, root.branchId, null)).rejects.toThrow();
  expect((await f.read(root).expect(200)).body.plan).toEqual(before.plan);
  const after = (await f.write(root, 'root-still-writable', rootHead, before.receipt.ref, 'root survives orphan').expect(200)).body as PlanMutationResult;
  expect((await f.read(root).expect(200)).body.plan).toEqual(after.plan);
});

function modelReply(response: ServerResponse, output: unknown[]) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`);
}
const call = (name: string, id: string, args: unknown) => ({ type: 'function_call', id: `item-${id}`, call_id: id, name, arguments: JSON.stringify(args) });
const done = [{ id: 'done', type: 'message', content: [{ type: 'output_text', text: 'Done' }] }];

async function toolFixture(reply: (body: Record<string, unknown>, turn: number) => unknown[], existingRoot?: string) {
  const f = await fixture(existingRoot);
  const storage = new KernelStorageAdapter({ client: f.kernel, hostId: 'plan-integration', storageRoot: f.root, resolveWorkspaceRoot: async () => f.root });
  cleanups.push(() => storage.dispose());
  const personalization = createAgentPersonalization({ client: f.kernel, context: async () => ({ bot: false }) });
  const prepareContext = createThreadContext({ personalization, resources: resourceScopeFixture(f.root, createKernelWorkspaceWorkingStateAccess(storage)), projectForWorkspace: async () => undefined });
  f.scopeContext.prepare = identity => prepareContext.main(identity, null);
  f.kernel.setMemoryOwner(createMemoryOwner({ personalization, prepareContext }));
  const queries: PlanQuery[] = [];
  const control = { loseReply: false };
  const owner = createPlanOwner(async () => f.store, f.runtime);
  f.kernel.setPlanOwner(async (query, signal) => {
    queries.push(structuredClone(query));
    const result = await owner(query, signal);
    if (control.loseReply && query.action === 'mutate' && result.status === 'ready' && result.mutation?.receipt.status === 'applied') {
      control.loseReply = false;
      throw new Error('Review lost Host reply after real KnowledgeStore commit');
    }
    return result;
  });
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; requests.push(body);
      modelReply(res, reply(body, requests.length));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  const endpoint = `http://127.0.0.1:${address.port}/responses`;
  const configuration: ModelSessionConfiguration = { providerFamily: 'openai-responses', model: 'fixture', endpoint,
    credentialEnvironment: null, allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 64 };
  const credentialOwner = new ExistingHostCredentialOwner({ providerId: 'fixture-provider', providerFamily: 'openai-responses', endpoint,
    currentScope: async () => ({ reference: 'fixture-reference', authority: 'fixture-owner', account: 'loopback-only', generation: 1 }),
    runtime: { getAuth: async () => ({ auth: { apiKey: 'fake-plan-review-key' } }) } });
  f.models.resolveModel = async () => ({ configuration, credentialOwner });
  f.models.rebindModel = async () => credentialOwner;
  const submit = async (identity: ThreadIdentity, mode: 'agent' | 'bot' = 'agent', threadRole: 'main' | 'worker' | 'read-only' = 'main') => {
    const view = await f.runtime.planView(identity.branchId);
    let receipt: InputSubmitReceipt;
    if (mode === 'agent' && threadRole === 'main') {
      // Main flow crosses the actual HTTP launch/rebind path, including default source inheritance.
      receipt = (await f.post('submit', { ...identity, key: `tool:${identity.branchId}:${view.headId}`, expectedHead: view.headId,
        text: 'Maintain the conversation plan', model: { providerId: 'fixture-provider', modelId: 'fixture' } }).expect(200)).body as InputSubmitReceipt;
    } else {
      // Only the trusted fixture can admit non-main scopes; the user route cannot choose a role.
      receipt = await f.runtime.submit({ key: `tool:${identity.branchId}:${view.headId}`, threadId: identity.threadId, branchId: identity.branchId, expectedHead: view.headId,
        input: { text: 'Maintain the conversation plan' }, initialContext: await prepareContext(identity, null, { mode, threadRole, projectId: null }),
        configuration: { ...configuration, allowAnonymous: true } });
      await f.runtime.startRun(receipt.run_id);
    }
    await expect.poll(async () => ['completed', 'failed'].includes((await f.runtime.run(receipt.run_id)).state), { timeout: 10_000 }).toBe(true);
    expect((await f.runtime.context(identity.branchId))?.personalization).toMatchObject({ mode, threadRole, sessionId: identity.threadId });
    expect(requests.length).toBeGreaterThan(0);
    const diagnostics = process.env.VARIN_PLAN_REVIEW_DIAGNOSTICS;
    if (diagnostics) {
      await fs.mkdir(diagnostics, { recursive: true });
      await fs.writeFile(path.join(diagnostics, `${receipt.run_id.replaceAll(':', '_')}.json`), JSON.stringify({
        run: await f.runtime.run(receipt.run_id), launch: await f.runtime.launch(receipt.run_id),
        history: await f.runtime.history(identity.branchId), events: await f.runtime.events(0, 256), requests, queries,
      }, null, 2));
    }
    return receipt;
  };
  return { ...f, queries, control, requests, submit, close: async () => { await storage.dispose(); await f.store.close(); await f.kernel.close(); } };
}

it('actual todo uses the admitted Operation and returns the same immutable revision as the HTTP card API', async () => {
  const f = await toolFixture((_body, turn) => turn === 1
    ? [call('todo', 'plan-update', { action: 'update', expectedRef: null, items: [{ text: 'Real tool plan', status: 'pending' }] })] : done);
  const identity = await f.create('todo'); const run = await f.submit(identity);
  const mutation = f.queries.find(query => query.action === 'mutate')!; expect(mutation).toBeDefined();
  expect(mutation.view).toMatchObject({ threadId: identity.threadId, branchId: identity.branchId });
  expect(mutation.origin).toMatchObject({ kind: 'tool', runId: run.run_id, callId: 'plan-update', epoch: (await f.runtime.run(run.run_id)).epoch });
  const operation = await f.runtime.operation(mutation.origin.operationId);
  expect(operation).toMatchObject({ run_id: run.run_id, outcome: 'succeeded', effect: 'confirmed' });
  const admission = { runId: run.run_id, ownerGeneration: mutation.origin.epoch,
    requestId: mutation.origin.requestId, callId: mutation.origin.callId };
  expect((await f.runtime.admission(admission)).state).toBe('settled');
  await expect(f.runtime.admission({ ...admission, ownerGeneration: admission.ownerGeneration + 1 })).rejects.toThrow();
  await expect(f.runtime.admission({ ...admission, callId: 'forged-call' })).rejects.toThrow();
  const state = (await f.read(identity).expect(200)).body;
  expect(state.plan).toMatchObject({ content: '- [ ] Real tool plan', updatedBy: 'agent' });
  expect(JSON.stringify(operation.result)).toContain(state.plan.ref);
  expect(JSON.stringify(f.requests[1])).toContain(state.plan.ref);
  const edit = (await f.write(identity, 'user-after-tool', state.headId, state.plan.ref, '- [x] User completed it').expect(200)).body as PlanMutationResult;
  expect((await f.plans.read(identity)).plan?.ref).toBe(edit.receipt.ref);
});

it('a forged model ownership field is rejected before the private plan owner can mutate', async () => {
  const f = await toolFixture((_body, turn) => turn === 1
    ? [call('todo', 'forged-owner', { action: 'update', expectedRef: null, items: [{ text: 'forged', status: 'pending' }], threadId: 'thread:someone-else' })] : done);
  const identity = await f.create('model-forged-owner'); await f.submit(identity);
  expect(f.queries.filter(query => query.action === 'mutate')).toEqual([]);
  expect((await f.read(identity).expect(200)).body.plan).toBeNull();
});

it.each([
  { mode: 'bot' as const, role: 'main' as const },
  { mode: 'agent' as const, role: 'worker' as const },
  { mode: 'agent' as const, role: 'read-only' as const },
])('todo cannot mutate from admitted $mode/$role scope', async ({ mode, role }) => {
  const f = await toolFixture((_body, turn) => turn === 1
    ? [call('todo', 'forbidden-scope', { action: 'update', expectedRef: null, items: [{ text: 'forbidden', status: 'pending' }] })] : done);
  const identity = await f.create(`forbidden-${mode}-${role}`, false); await f.submit(identity, mode, role);
  await f.read(identity).expect(400);
  await f.write(identity, 'forbidden-user-route', (await f.runtime.planView(identity.branchId)).headId, null, 'forbidden').expect(400);
  expect(f.queries.filter(query => query.action === 'mutate')).toEqual([]);
  expect((await f.store.readPlanCandidate(await f.runtime.planView(identity.branchId))).candidate).toBeNull();
});

it('lost Host reply reconciles the original Operation receipt after a user edit and owner/kernel reopen', async () => {
  const f = await toolFixture((_body, turn) => turn === 1
    ? [call('todo', 'lost-plan-reply', { action: 'update', expectedRef: null, items: [{ text: 'Committed tool plan', status: 'pending' }] })] : done);
  const identity = await f.create('lost-plan-operation'); f.control.loseReply = true;
  const run = await f.submit(identity);
  const query = f.queries.find(item => item.action === 'mutate')!; expect(query).toBeDefined();
  const operationId = query.origin.operationId;
  expect(await f.runtime.operation(operationId)).toMatchObject({ outcome: 'indeterminate', effect: 'unknown' });
  const original = (await f.read(identity).expect(200)).body;
  expect(original.plan.content).toBe('- [ ] Committed tool plan');
  const newer = (await f.write(identity, 'user-after-lost-reply', original.headId, original.plan.ref, 'User changed the plan').expect(200)).body as PlanMutationResult;
  await f.close();
  const reopened = await toolFixture(() => done, f.root);
  let mutations = 0; const mutate = reopened.store.mutatePlan.bind(reopened.store);
  reopened.store.mutatePlan = async input => { mutations++; return mutate(input); };
  const result = await reopened.runtime.reconcilePlan(run.run_id);
  expect(result).toMatchObject({ reconciled: [operationId], unresolved: [] });
  expect(reopened.queries.filter(item => item.action === 'receipt')).toEqual([{ ...query, action: 'receipt' }]);
  expect(reopened.queries.some(item => item.action === 'mutate')).toBe(false);
  expect(mutations).toBe(0);
  const reconciled = await reopened.runtime.operation(operationId);
  expect(reconciled).toMatchObject({ outcome: 'succeeded', effect: 'confirmed' });
  expect(JSON.stringify(reconciled.result)).toContain(original.plan.ref);
  expect((await reopened.read(identity).expect(200)).body.plan).toEqual(newer.plan);
  await reopened.runtime.reconcilePlan(run.run_id);
  expect(mutations).toBe(0); expect(reopened.requests).toHaveLength(0);
});

it('todo rejects invalid status without writing a plan', async () => {
  const f = await toolFixture((_body, turn) => turn === 1
    ? [call('todo', 'invalid-status', { action: 'update', expectedRef: null, items: [{ text: 'bad status', status: 'invented-status' }] })] : done);
  const identity = await f.create('tool-invalid-status'); await f.submit(identity);
  expect((await f.read(identity).expect(200)).body.plan).toBeNull();
});

it('todo empty items create a real empty revision using the shared plan contract', async () => {
  const f = await toolFixture((_body, turn) => turn === 1
    ? [call('todo', 'empty-plan', { action: 'update', expectedRef: null, items: [] })] : done);
  const identity = await f.create('tool-empty-plan'); await f.submit(identity);
  const state = (await f.read(identity).expect(200)).body;
  expect(state.plan).toMatchObject({ content: '', previousRef: null, updatedBy: 'agent' });
  const empty = f.queries.find(query => query.origin.callId === 'empty-plan' && query.action === 'mutate')!;
  expect(empty).toBeDefined();
  expect(JSON.stringify(await f.runtime.operation(empty.origin.operationId))).toContain(state.plan.ref);
});

it('a real Catalog fork with fabricated null capture is not an authorized empty plan', async () => {
  const f = await fixture(); const source = await f.create('fabricated-null');
  const targetBranchId = 'branch:missing-null-capture';
  await f.runtime.forkBranch(source.branchId, targetBranchId, null, undefined, {
    sourceThreadId: source.threadId, sourceBranchId: source.branchId, targetBranchId,
    headId: null, inheritedRef: null, capturedRef: null,
  });
  const target = { ...source, branchId: targetBranchId };
  expect((await f.runtime.planView(targetBranchId)).forkBasis).toBeTruthy();
  await f.read(target).expect(400);
  await f.write(target, 'cannot-write-missing-capture', null, null, 'forged empty basis').expect(400);
});

it('Catalog source/head identity and persisted capture must agree even when both captured refs are null', async () => {
  const f = await fixture(); const source = await f.create('capture-source-a');
  const other = { ...source, branchId: 'branch:legacy-source-b' };
  await f.runtime.forkBranch(source.branchId, other.branchId, null);
  const targetBranchId = 'branch:changed-capture-source';
  const capture = await f.plans.capture(source, null, targetBranchId);
  await f.runtime.forkBranch(other.branchId, targetBranchId, null, undefined, { ...capture, sourceBranchId: other.branchId });
  await f.read({ ...source, branchId: targetBranchId }).expect(400);
  expect((await f.read(source).expect(200)).body.plan).toBeNull();
});

it('Catalog rejects a forged source inherited reference before creating the branch', async () => {
  const f = await fixture(); const source = await f.create('capture-source-proof'); const targetBranchId = 'branch:forged-inherited-source';
  const capture = await f.plans.capture(source, null, targetBranchId);
  await expect(f.runtime.forkBranch(source.branchId, targetBranchId, null, undefined, { ...capture, inheritedRef: 'forged-source-reference' })).rejects.toThrow();
  expect((await f.runtime.thread(source.threadId)).branches.some(branch => branch.branch_id === targetBranchId)).toBe(false);
});

it('bounded Catalog membership pages the head search and authenticates cursors across identity changes and reopen', async () => {
  const f = await fixture(); const identity = await f.create('paged-membership');
  const fixedHead = await f.append(identity, 'membership-head');
  const seed = (await f.write(identity, 'membership-plan', fixedHead, null, 'old-head plan').expect(200)).body as PlanMutationResult;
  for (let index = 0; index < 256; index++) await f.append(identity, `membership-tail-${index}`);
  const input = { branchId: identity.branchId, headId: fixedHead, candidateHeadId: null };
  const first = await f.kernel.agentRuntimeRequest('runtime.plan.contains', input) as { status: string; cursor?: string };
  expect(first.status).toBe('pending'); expect(first.cursor).toBeTruthy();
  const continued = { ...input, cursor: first.cursor! };
  expect(await f.kernel.agentRuntimeRequest('runtime.plan.contains', continued)).toEqual({ status: 'ready', visible: true });
  const signature = first.cursor!.at(-1)!;
  await expect(f.kernel.agentRuntimeRequest('runtime.plan.contains', { ...continued,
    cursor: first.cursor!.slice(0, -1) + (signature === '0' ? '1' : '0') })).rejects.toThrow();
  await expect(f.kernel.agentRuntimeRequest('runtime.plan.contains', { ...continued, candidateHeadId: fixedHead })).rejects.toThrow();
  await expect(f.kernel.agentRuntimeRequest('runtime.plan.contains', { ...continued, headId: null })).rejects.toThrow();
  const other = await f.create('paged-other');
  await expect(f.kernel.agentRuntimeRequest('runtime.plan.contains', { ...continued, branchId: other.branchId })).rejects.toThrow();
  const cancelled = new AbortController();
  const contains = f.runtime.planContains.bind(f.runtime); let pages = 0; let mutations = 0;
  const mutate = f.store.mutatePlan.bind(f.store);
  f.store.mutatePlan = async value => { mutations++; return mutate(value); };
  f.runtime.planContains = async (...args) => {
    const result = await contains(...args); pages++;
    if (result.status === 'pending') cancelled.abort();
    return result;
  };
  await expect(f.plans.update({ ...identity, key: 'cancel-during-selection',
    expectedHeadId: (await f.runtime.planView(identity.branchId)).headId, expectedRef: seed.receipt.ref, content: 'must not dispatch' }, cancelled.signal)).rejects.toThrow();
  expect(pages).toBe(1); expect(mutations).toBe(0);
  f.runtime.planContains = contains;
  await f.runtime.status();
  await f.store.close(); await f.kernel.close();
  const reopened = await fixture(f.root);
  await expect(reopened.kernel.agentRuntimeRequest('runtime.plan.contains', continued)).rejects.toThrow();
  expect(await reopened.kernel.agentRuntimeRequest('runtime.plan.contains', { branchId: identity.branchId, headId: null, candidateHeadId: null }))
    .toEqual({ status: 'ready', visible: true });
}, 45_000);

it('a real todo CAS conflict settles with its structured no-effect receipt and preserves the user revision', async () => {
  const f = await toolFixture((_body, turn) => turn === 1
    ? [call('todo', 'tool-conflict', { action: 'update', expectedRef: null, items: [{ text: 'stale model plan', status: 'pending' }] })] : done);
  const identity = await f.create('tool-cas-conflict');
  const current = (await f.write(identity, 'user-before-tool', null, null, 'user current plan').expect(200)).body as PlanMutationResult;
  const run = await f.submit(identity);
  const query = f.queries.find(item => item.action === 'mutate')!; expect(query).toBeDefined();
  const operation = await f.runtime.operation(query.origin.operationId);
  expect(operation).toMatchObject({ run_id: run.run_id, phase: 'terminal', outcome: 'failed', effect: 'none',
    result: { status: 'ready', mutation: { receipt: { status: 'conflict', ref: current.receipt.ref, origin: query.origin } } } });
  expect((await f.read(identity).expect(200)).body.plan).toEqual(current.plan);
  const wire = (f.requests[1]!.input as Array<Record<string, unknown>>).find(item => item.type === 'function_call_output' && item.call_id === 'tool-conflict');
  expect(JSON.parse(String(wire?.output))).toMatchObject({ kind: 'result', outcome: 'failed', effect: 'none',
    content: { mutation: { receipt: { status: 'conflict', ref: current.receipt.ref } } } });
});
