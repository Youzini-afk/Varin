/** Original Bot/Knowledge/credential owners over the established Rust↔Host stdio fixture.
 * Provider generation and the pre-existing Pi conversation bytes are controlled; no listener opens. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import express, { type Express } from 'express';
import { HostCredentialAuthority } from '@varin/pi-host/credentials';
import type { PiSessionEntry } from '@varin/protocol';
import type { ChatMemoryExtraction } from '@varin/application-client';
import { KernelClient } from './kernel-client.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { createModelAuthority } from './model-authority.js';
import type { KernelHandshakeResult } from './protocol.generated.js';
import { createBotService } from '../bots/bot-service.js';
import { createBotLifecycleRuntime } from '../bots/bot-lifecycle-runtime.js';
import { createMemoryInference } from '../memory/memory-inference.js';
import { createMemoryOrganizer } from '../memory/memory-organizer.js';
import { createMemoryService } from '../memory/memory-service.js';
import { registerSelectionMemoryRoutes } from '../memory/selection-memory-routes.js';
import { openWorkspaceKnowledge } from '../knowledge/store.js';
import type { KnowledgeStore } from '../knowledge/store-contract.js';
import { createSemanticInference } from '../knowledge/semantic/runtime-inference.js';
import { createEgressRuntime } from '../harness/egress.js';
import { routerTransport } from '../extensions/direct-router.test-helper.js';

const HOST = 'web-domain-host', GENERATION = 'web-domain-generation';
const originalText = 'Always document the exact recovery evidence before marking a task finished.';
const entry: PiSessionEntry = { id: 'original-user-entry', parentId: null, type: 'message', timestamp: '2026-10-12T00:00:00Z',
  message: { role: 'user', timestamp: 1, content: originalText } };
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const errors: string[] = [];
const knownWorkIds = new Set<string>();
let sequence = 0, root = '', mode = '', botId = '', scopeId = '', sessionId = '', decisionRequests = 0;
let reopening = false;
let kernel: KernelClient, runtime: AgentRuntimeClient;
let bots: ReturnType<typeof createBotService>, organizer: ReturnType<typeof createMemoryOrganizer>;
let memory: ReturnType<typeof createMemoryService>, inference: ReturnType<typeof createMemoryInference>;
let semantic: ReturnType<typeof createSemanticInference>, egress: ReturnType<typeof createEgressRuntime>;
let authority: HostCredentialAuthority;
let store: KnowledgeStore, userStore: KnowledgeStore;
let transport: ReturnType<typeof routerTransport>;
let lastPreview: ChatMemoryExtraction | undefined;
let closed = false;
let initialized = false;
const startupFrames: Record<string, unknown>[] = [];
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const unexpected = async (): Promise<never> => { throw new Error('The memory fixture attempted an unrelated executor'); };
function request(method: string, params: unknown, options: { grant?: { grantId: string } } = {}): Promise<unknown> {
  if (mode === 'recover-decision' && !reopening && method === 'runtime.memory_work.update'
    && (params as { action?: { kind?: string } }).action?.kind === 'decision') {
    send({ kind: 'fixture-before-decision', workId: (params as { workId: string }).workId, decisionRequests });
    return new Promise(() => {});
  }
  const id = `bot-memory:${++sequence}`;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  send({ kind: 'fixture-request', id, method, params, ...(options.grant ? { grantId: options.grant.grantId } : {}) });
  return result;
}
async function settings(disabled = false) {
  await writeFile(join(root, 'agent/settings.json'), JSON.stringify({ harness: {
    // Automatic work intentionally uses the real Bot profile fallback. Explicit selection has its own configured slot.
    models: { memoryOrganizer: disabled ? { enabled: false } : mode.startsWith('selection')
      ? { providerId: 'memory-review', modelId: 'configured-organizer' } : {} },
    knowledge: { autoOrganize: { bot: !mode.startsWith('selection'), user: false } },
    ...(mode.includes('decision') ? { fastDecision: { default: { protocol: 'pi-classifier', providerId: 'memory-decision', modelId: 'classifier' } } } : {}),
  } }));
}
async function snapshot() {
  for (const work of await inference.list(scopeId)) knownWorkIds.add(work.workId);
  const rows = await store.listOrganizerProgress();
  for (const row of rows) if (row.workId) knownWorkIds.add(row.workId);
  return { bot: await bots.get(botId), scopeId, sessionId,
    works: await Promise.all([...knownWorkIds].map(id => inference.read(id))), rows,
    memories: await memory.list({ scope: 'bot', ownerId: botId }), errors: [...errors], decisionRequests };
}
async function waitFor(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 45_000;
  while (!await predicate()) {
    assert(Date.now() < deadline, 'Original Bot memory consumer did not reach its expected boundary');
    await delay(10);
  }
}
async function initialize(frame: Record<string, unknown>) {
  root = String(frame.root); mode = String(frame.mode); reopening = frame.reopen === true;
  const agentDir = join(root, 'agent'); await mkdir(agentDir, { recursive: true });
  if (!frame.reopen) {
    await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'memory-review': {
      baseUrl: 'https://memory.invalid/v1', apiKey: 'controlled-memory-fixture-key', api: 'openai-responses',
      models: ['bot-profile-model', 'configured-organizer'].map(id => ({ id, name: id, contextWindow: 32768, maxTokens: 2048, input: ['text'] })),
    }, 'memory-decision': { baseUrl: 'https://classifier.invalid', apiKey: 'controlled-classifier-key',
      models: [{ id: 'classifier', type: 'classifier', api: 'typesafe-system-one' }],
      capabilities: { decision: { protocol: 'pi-classifier', models: [{ id: 'classifier', api: 'typesafe-system-one' }] } },
    } } }));
    await settings();
  }
  kernel = new KernelClient({ hostId: HOST, hostGeneration: GENERATION, storageRoot: String(frame.storageRoot), buildVersion: '0.9.25' });
  const delivery = kernel as unknown as { epoch: string; started: boolean; handshakeResult: KernelHandshakeResult };
  delivery.epoch = String(frame.epoch); delivery.started = true;
  delivery.handshakeResult = { hostId: HOST, storageRoot: String(frame.storageRoot), kernelEpoch: String(frame.epoch) } as KernelHandshakeResult;
  Object.defineProperty(kernel, 'requestRaw', { value: request });
  Object.defineProperty(kernel, 'write', { value: async (value: unknown) => { send(value); } });
  runtime = new AgentRuntimeClient(kernel);
  authority = HostCredentialAuthority.open(agentDir);
  egress = createEgressRuntime({ env: {}, resolveAll: async () => [{ address: '93.184.216.34', family: 4 }],
    systemFetch: async (url, init) => {
      assert(mode.includes('decision')); assert(!reopening, 'Recovery must interpret original classifier bytes, never send another request');
      assert.equal(url, 'https://classifier.invalid/systemone'); assert.equal(init.method, 'POST');
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer controlled-classifier-key');
      init.signal?.throwIfAborted();
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      decisionRequests++;
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id,
        { type: 'noul', noul: mode === 'recover-decision' ? 0 : 1 }])), usage: { input_tokens: 11, output_tokens: 2 } });
    } });
  semantic = createSemanticInference(authority, undefined, { requests: { kernel, runtime, egress } });

  // The registry has no delegated work in this finite fixture. Bot identity and activity are original durable records.
  const registry = { listRuns: async () => [], listWorkspaceThreadSnapshots: async () => [],
    listWorkspaceRunSessionIds: async () => [], flushScope: async () => {} };
  const lifecycle = createBotLifecycleRuntime({ hostId: HOST,
    registry: registry as unknown as Parameters<typeof createBotLifecycleRuntime>[0]['registry'],
    runtime: { suspendForBot: unexpected } as unknown as Parameters<typeof createBotLifecycleRuntime>[0]['runtime'],
    broker: { requestForSession: async () => ({ isStreaming: false, busy: false }), openSession: unexpected, closeSession: async () => {} } as unknown as Parameters<typeof createBotLifecycleRuntime>[0]['broker'],
    computers: { list: async () => ({ desktops: [] }), listVms: async () => [], workDesktops: async () => [] } as unknown as Parameters<typeof createBotLifecycleRuntime>[0]['computers'],
    stopSessionProcesses: async () => {}, stopRemoteScope: async () => {}, resumeRemoteScope: async () => {},
    remoteMachineOwners: async () => [], stopRoot: async () => {},
    stopMemory: scope => organizer.suspendScope(scope), resumeMemory: scope => organizer.resumeScope(scope), wakeFollowUps: async () => {},
  });
  bots = createBotService({ client: kernel, hostId: HOST, dataDir: root, registry,
    publishExecutionGate: gate => kernel.agentRuntimeRequest<void, 'runtime.bot.gate.publish'>('runtime.bot.gate.publish', gate),
    createSession: async () => ({ sessionId: 'original-bot-conversation' }), openSession: async input => ({ sessionId: input.sessionId }),
    lifecycle: () => lifecycle, onError: error => errors.push(String(error)) });
  await bots.publishExecutionGates();
  if (frame.reopen) {
    ({ botId, scopeId, sessionId } = JSON.parse(await readFile(join(root, 'memory-fixture.json'), 'utf8')));
    assert(await bots.get(botId));
  } else {
    const bot = await bots.create({ name: 'Memory review Bot', model: { providerId: 'memory-review', modelId: 'bot-profile-model' } });
    botId = bot.id; scopeId = `bot:${botId}`; ({ sessionId } = await bots.ensureEntry(botId));
    await writeFile(join(root, 'memory-fixture.json'), JSON.stringify({ botId, scopeId, sessionId }));
  }
  const canExecute = (scope: string) => bots.canExecute(scope.slice(4));
  inference = createMemoryInference({ kernel, runtime, models: createModelAuthority(authority), authority, decision: semantic,
    validateScope: async scope => { const bot = scope.startsWith('bot:') ? await bots.get(scope.slice(4)) : null; assert(bot && !bot.archived); },
    canExecuteScope: canExecute });
  store = await openWorkspaceKnowledge({ dataDir: join(root, 'knowledge-bot'), hostId: HOST, workspaceId: botId, scope: 'bot', embedding: null });
  userStore = await openWorkspaceKnowledge({ dataDir: join(root, 'knowledge-user'), hostId: HOST, workspaceId: 'user', scope: 'user', embedding: null });
  if (mode === 'recover-output' && !frame.reopen) {
    const put = store.putOrganizerProgress.bind(store);
    store.putOrganizerProgress = async row => {
      if (row.status === 'prepared') {
        // Stop after the original model result is durable, before domain prepare.
        // The Rust test drops this Host and opens these same stores again.
        send({ kind: 'fixture-before-prepared', workId: row.workId });
        await new Promise<void>(() => {});
      }
      return put(row);
    };
  }
  if (frame.reopen && mode === 'recover-output') {
    // A newer live preference must not rename or replace the accepted recipe/result.
    await bots.update(botId, { model: { providerId: 'memory-review', modelId: 'configured-organizer' } });
  }
  const ownerForSession = async (id: string) => { const bot = await bots.botForSession(id); assert(bot); return { scope: 'bot' as const, ownerId: bot.id }; };
  memory = createMemoryService({ storeForScopeId: async scope => { assert.equal(scope, scopeId); return store; },
    userStore: async () => userStore, ownerForSession, readSessionEntries: async id => { assert.equal(id, sessionId); return [entry]; } });
  organizer = createMemoryOrganizer({ getInference: () => inference,
    storeForScopeId: async scope => { assert.equal(scope, scopeId); return store; }, hasStoreForScope: async () => true,
    listScopeIds: async () => [scopeId], listScopeSessions: async scope => scope === scopeId ? [sessionId] : [], listRunSources: async () => [],
    scopeForSession: async id => { const bot = await bots.botForSession(id); return bot ? `bot:${bot.id}` : null; },
    readEntries: async id => { assert.equal(id, sessionId); return [entry]; },
    organizerModelForScope: async scope => (await bots.get(scope.slice(4)))?.model ?? null,
    canExecuteScope: canExecute, memory, onError: error => errors.push(error instanceof Error ? error.message : String(error)),
  });
  const router = express.Router();
  registerSelectionMemoryRoutes(router as unknown as Express, { memory,
    entries: async id => { assert.equal(id, sessionId); return [entry]; },
    narrate: (...args) => organizer.extractSelection(...args),
    requireAuth: (req, res, next) => req.headers['x-varin-application-token'] === 'fixture-application-token'
      ? next() : res.status(401).json({ error: 'Authentication required' }),
  });
  transport = routerTransport(router);
  // A restarted Host can receive the existing durable cursor while its async
  // fixture bootstrap is still opening the original owners. Preserve that
  // delivery until the KernelClient and its actual consumers are installed.
  initialized = true;
  for (const value of startupFrames.splice(0)) {
    (kernel as unknown as { consumeFrame(value: unknown): void }).consumeFrame(value);
  }
  send({ kind: 'fixture-prepared', scopeId, botId, sessionId, originalText });
}
async function selection(frame: Record<string, unknown>, resultKind: string) {
  const key = String(frame.requestKey ?? 'selection-original');
  const response = await transport(new URL(`https://host.invalid/api/harness/sessions/${sessionId}/knowledge/extracted/preview`), {
    method: 'POST', headers: { 'x-varin-application-token': 'fixture-application-token' },
    body: JSON.stringify({ requestKey: key, ...(frame.retryOf ? { retryOf: String(frame.retryOf) } : {}),
      sources: [{ entryId: entry.id, start: 0, text: originalText }] }),
  });
  const work = await inference.find(key); if (work) knownWorkIds.add(work.workId);
  const body = await response.json();
  if (!response.ok) console.error('Original selection consumer response:', response.status, JSON.stringify(body));
  if (response.ok) lastPreview = body as ChatMemoryExtraction;
  send({ kind: resultKind, status: response.status, body, ...await snapshot() });
}
async function handle(frame: Record<string, unknown>) {
  if (frame.kind === 'fixture-response') {
    const current = pending.get(String(frame.id)); assert(current); pending.delete(String(frame.id));
    if (frame.ok) current.resolve(frame.result); else current.reject(new Error(String(frame.error)));
    return;
  }
  if (frame.kind === 'fixture-initialize') return initialize(frame);
  if (frame.kind === 'fixture-run') {
    if (mode.startsWith('selection')) return selection(frame, 'fixture-result');
    organizer.noteSessionSettled(sessionId);
    await waitFor(async () => {
      const rows = await store.listOrganizerProgress();
      return organizer.pending === 0 && (errors.length > 0 || rows.some(row => ['formed', 'reviewed-empty', 'failed'].includes(row.status)));
    });
    send({ kind: 'fixture-result', ...await snapshot() }); return;
  }
  if (frame.kind === 'fixture-selection') return selection(frame, 'fixture-selection-result');
  if (frame.kind === 'fixture-save') {
    assert(lastPreview?.drafts[0]);
    const response = await transport(new URL(`https://host.invalid/api/harness/sessions/${sessionId}/knowledge/extracted`), {
      method: 'POST', headers: { 'x-varin-application-token': 'fixture-application-token' },
      body: JSON.stringify({ target: 'owner', expectedOwner: lastPreview.owner, draft: lastPreview.drafts[0] }),
    });
    send({ kind: 'fixture-saved', status: response.status, body: await response.json(), ...await snapshot() }); return;
  }
  if (frame.kind === 'fixture-sleep') {
    await bots.sleep(botId);
    await waitFor(async () => ['asleep', 'sleep-failed'].includes((await bots.get(botId))?.activity?.state ?? ''));
    send({ kind: 'fixture-sleep-result', ...await snapshot() }); return;
  }
  if (frame.kind === 'fixture-disable') { await settings(true); send({ kind: 'fixture-disabled' }); return; }
  if (frame.kind === 'fixture-inspect') { send({ kind: 'fixture-inspected', ...await snapshot() }); return; }
  if (frame.kind === 'fixture-close') {
    await organizer.dispose(); await semantic.close(); await bots.dispose(); await store.close(); await userStore.close(); await egress.close();
    closed = true; send({ kind: 'fixture-closed' }); return;
  }
  if (!closed) {
    if (!initialized) startupFrames.push(frame);
    else (kernel as unknown as { consumeFrame(value: unknown): void }).consumeFrame(frame);
  }
}
createInterface({ input: process.stdin }).on('line', line => {
  void handle(JSON.parse(line)).catch(error => send({ kind: 'fixture-failed', error: error instanceof Error ? error.stack : String(error) }));
});
