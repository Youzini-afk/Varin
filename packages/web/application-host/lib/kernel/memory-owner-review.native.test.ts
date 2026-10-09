import { afterEach, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKernelClient } from './kernel-client.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { createAgentPersonalization } from '../memory/agent-personalization.js';
import { createPersonalizationContextResolver } from '../memory/personalization-context.js';
import { registerAgentPersonalizationRoutes } from '../memory/agent-personalization-routes.js';
import { registerCommonRequestMiddleware } from '../platform/core-routes.js';

const buildVersion = (JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, '../../../../../package.json'), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-memory-owner-review-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const open = () => {
    const client = createKernelClient({ hostId: 'memory-owner-review', storageRoot: root, buildVersion,
      kernelPath: process.env.VARIN_TEST_KERNEL_PATH!, allowCargoDevRunner: false });
    cleanups.push(() => client.close());
    return client;
  };
  return { root, open, client: open() };
}
async function admitScope(runtime: AgentRuntimeClient, name: string, mode: 'agent' | 'bot', role: 'main' | 'worker' | 'read-only', projectId: string | null) {
  const threadId = `thread:${name}`, branchId = `branch:${name}`;
  await runtime.createThread(threadId, branchId);
  await runtime.submit({ key: `scope:${name}`, threadId, branchId, expectedHead: null, input: { text: 'admit the trusted fixture scope' }, configuration: {},
    initialContext: { effectiveSystemPrompt: 'FIXED_SCOPE_SYSTEM', instructionSources: ['scope-fixture'], memoryCheckpoint: 'scope-fixture:0',
      personalization: { mode, threadRole: role, sessionId: threadId, projectId, revision: 0, configurationDigest: 'scope-fixture-profile',
        memorySnapshot: { revision: 0, memories: [] }, originalSections: [{ name: 'preamble', content: 'FIXED_SCOPE_SYSTEM' }], instructionSources: ['scope-fixture'] } } });
  return { threadId, branchId };
}

it('production scope resolution and HTTP notes share persisted identity, exact CAS and Bot rejection without falling into Pi', async () => {
  const f = await fixture(); const runtime = new AgentRuntimeClient(f.client);
  const main = await admitScope(runtime, 'scope-main', 'agent', 'main', 'project-a');
  const child = await admitScope(runtime, 'scope-child', 'agent', 'worker', 'project-a');
  const other = await admitScope(runtime, 'scope-other', 'agent', 'read-only', 'project-b');
  const bot = await admitScope(runtime, 'scope-bot', 'bot', 'main', 'project-a');
  const legacyCalls: string[] = [];
  const resolve = createPersonalizationContextResolver({ runtime: () => runtime, legacy: async id => {
    legacyCalls.push(id); return { bot: false, threadRole: 'worker', projectId: 'pi-project' };
  } });
  const service = createAgentPersonalization({ client: f.client, context: resolve });
  const app = express(); registerCommonRequestMiddleware(app, { express });
  registerAgentPersonalizationRoutes(app, service, (_req, _res, next) => next());
  const put = (scope: unknown, content: string, revision: number) => request(app).put('/api/agent-personalization/memory').send({ scope, content, revision });
  const global = await put({ kind: 'global' }, 'HTTP_GLOBAL', 0).expect(200);
  await put({ kind: 'project', id: 'project-a' }, 'HTTP_PROJECT_A', global.body.revision).expect(200);
  const current = await put({ kind: 'session', id: main.threadId }, 'HTTP_MAIN_PRIVATE', 2).expect(200);
  expect((await service.context(main.threadId))).toMatchObject({ mode: 'agent', threadRole: 'main', projectId: 'project-a' });
  expect((await service.context(main.threadId)).memories.map(note => note.content)).toEqual(['HTTP_GLOBAL', 'HTTP_PROJECT_A', 'HTTP_MAIN_PRIVATE']);
  expect((await service.context(child.threadId))).toMatchObject({ threadRole: 'worker', projectId: 'project-a' });
  expect((await service.context(child.threadId)).memories.map(note => note.content)).toEqual(['HTTP_GLOBAL', 'HTTP_PROJECT_A']);
  expect((await service.context(other.threadId)).memories.map(note => note.content)).toEqual(['HTTP_GLOBAL']);
  const before = await service.catalog();
  await request(app).put('/api/agent-personalization/memory').send({ id: current.body.result.id, scope: { kind: 'session', id: main.threadId }, content: 'STALE_UI_EDIT', revision: 2 }).expect(409);
  await put({ kind: 'session', id: bot.threadId }, 'FORBIDDEN_BOT_NOTE', before.revision).expect(400);
  await request(app).put('/api/agent-personalization/prompt').send({ scope: { kind: 'session', id: bot.threadId }, profile: { sections: { preamble: 'FORBIDDEN_BOT_PROFILE' } }, revision: before.revision }).expect(400);
  await runtime.createThread('thread:unadmitted', 'branch:unadmitted');
  await put({ kind: 'session', id: 'thread:unadmitted' }, 'UNADMITTED_NOTE', before.revision).expect(409);
  await expect(resolve('thread:missing')).rejects.toThrow();
  expect(await service.catalog()).toEqual(before);
  expect(legacyCalls).toEqual([]);
  expect(await resolve('pi-original-session')).toEqual({ bot: false, threadRole: 'worker', projectId: 'pi-project' });
  expect(legacyCalls).toEqual(['pi-original-session']);
  expect(await service.context(bot.threadId)).toMatchObject({ mode: 'bot', memories: [], profiles: [] });
  await f.client.close();
  const reopened = f.open(); const restored = new AgentRuntimeClient(reopened);
  const resolveAgain = createPersonalizationContextResolver({ runtime: () => restored, legacy: async () => { throw new Error('scope must not query Pi'); } });
  expect(await resolveAgain(child.threadId)).toEqual({ bot: false, threadRole: 'worker', projectId: 'project-a' });
  expect(await resolveAgain(bot.threadId)).toEqual({ bot: true, threadRole: 'main', projectId: 'project-a' });
});

it('operation lookup distinguishes missing, owned, foreign and orphan identities under concurrent requests', async () => {
  const f = await fixture();
  const grant = async (client: typeof f.client, workspace: string) => client.scoped(await client.issueGrant({ grantId: `grant:${workspace}`,
    owningWorkspace: workspace, executionWorkspace: workspace, capabilities: ['storage.read', 'storage.write'], pathScopes: [''] }));
  const own = await grant(f.client, 'memory-owner-a'); const foreign = await grant(f.client, 'memory-owner-b');
  expect(await own.getOperation('truly-missing-operation')).toBeNull();
  const write = (client: typeof own, operationId: string, workspaceId: string) => client.putRecord({ operationId, workspaceId, recordId: operationId,
    recordType: 'recovery.metadata', state: 'active', payloadJson: JSON.stringify({ value: `PRIVATE_${workspaceId}` }), ownerIds: [], references: [] });
  await write(own, 'owned-operation', 'memory-owner-a');
  expect(await own.getOperation('owned-operation')).toMatchObject({ state: 'committed', kind: 'storage.record.put' });
  await expect(foreign.getOperation('owned-operation')).rejects.toThrow(/workspace|authority|grant/i);
  await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const id = `concurrent-foreign-${index}`;
    const results = await Promise.allSettled([own.getOperation(id), write(foreign, id, 'memory-owner-b'), own.getOperation(id)]);
    expect(results[1]!.status).toBe('fulfilled');
    for (const result of [results[0]!, results[2]!]) {
      if (result.status === 'fulfilled') expect(result.value).toBeNull();
      else expect(String(result.reason)).toMatch(/workspace|authority|grant/i);
    }
    await expect(own.getOperation(id)).rejects.toThrow(/workspace|authority|grant/i);
  }));
  await f.client.close();
  const database = new DatabaseSync(path.join(f.root, 'catalog.sqlite'));
  try {
    expect(database.prepare('SELECT count(*) AS count FROM operations WHERE operation_id=?').get('owned-operation')).toEqual({ count: 1 });
    database.prepare('DELETE FROM operation_owners WHERE operation_id=?').run('owned-operation');
  } finally { database.close(); }
  const reopened = f.open(); const restored = await grant(reopened, 'memory-owner-a');
  await expect(restored.getOperation('owned-operation')).rejects.toThrow(/owned|authority/i);
  expect(await restored.getOperation('still-truly-missing')).toBeNull();
});

it('resolver rejects unavailable ownership and inconsistent persisted branch scopes without legacy fallback', async () => {
  let legacyCalls = 0;
  const legacy = async () => { legacyCalls++; return { bot: false }; };
  await expect(createPersonalizationContextResolver({ runtime: () => undefined, legacy })('thread:scope')).rejects.toThrow(/not ready/);
  const f = await fixture(); const runtime = new AgentRuntimeClient(f.client);
  const identity = await admitScope(runtime, 'scope-validation', 'agent', 'worker', 'project-a');
  const actualThread = await runtime.thread(identity.threadId);
  const actualContext = await runtime.context(identity.branchId);
  expect(actualContext?.personalization).toBeTruthy();
  const resolve = (context: typeof actualContext, thread = actualThread) => createPersonalizationContextResolver({ legacy,
    runtime: () => ({ thread: async () => thread, context: async () => context }) });
  await expect(resolve(actualContext, { ...actualThread, thread_id: 'thread:foreign' })(identity.threadId)).rejects.toThrow(/ownership/);
  await expect(resolve({ ...actualContext!, personalization: { ...actualContext!.personalization!, sessionId: 'thread:foreign' } })(identity.threadId)).rejects.toThrow(/inconsistent/);
  const branches = { ...actualThread, branches: [...actualThread.branches, { ...actualThread.branches[0]!, branch_id: 'branch:other' }] };
  const inconsistent = createPersonalizationContextResolver({ legacy, runtime: () => ({ thread: async () => branches,
    context: async branch => branch === identity.branchId ? actualContext : { ...actualContext!, personalization: { ...actualContext!.personalization!, projectId: 'foreign-project' } } }) });
  await expect(inconsistent(identity.threadId)).rejects.toThrow(/inconsistent/);
  expect(legacyCalls).toBe(0);
});

it.each([
  { primary: 'id TEXT PRIMARY KEY', index: 'CREATE UNIQUE INDEX misleading_revision ON context_checkpoints(branch_id,revision) WHERE revision<0' },
  { primary: 'id TEXT PRIMARY KEY', index: 'CREATE UNIQUE INDEX misleading_revision ON context_checkpoints(branch_id COLLATE NOCASE,revision)' },
  { primary: 'id TEXT PRIMARY KEY', index: 'CREATE UNIQUE INDEX misleading_revision ON context_checkpoints(branch_id,revision DESC)' },
  { primary: 'id TEXT PRIMARY KEY COLLATE NOCASE', index: 'CREATE UNIQUE INDEX valid_revision ON context_checkpoints(branch_id,revision)' },
])('rejects malformed context uniqueness before epoch or user asset mutation: $primary $index', async ({ primary, index }) => {
  const f = await fixture(); const runtime = new AgentRuntimeClient(f.client);
  await runtime.createThread('thread:preserve-index', 'branch:preserve-index');
  await runtime.submit({ key: 'preserved-user', threadId: 'thread:preserve-index', branchId: 'branch:preserve-index', expectedHead: null,
    input: { text: 'PRESERVED_USER_ASSET' }, configuration: {} });
  await f.client.close();
  const file = path.join(f.root, 'agent-runtime/conversation.sqlite');
  const database = new DatabaseSync(file);
  database.exec(`DROP TABLE context_checkpoints; CREATE TABLE context_checkpoints(${primary},branch_id TEXT NOT NULL REFERENCES branches(id),revision INTEGER NOT NULL,through_id TEXT REFERENCES history(id),body TEXT NOT NULL,project_id TEXT); ${index}`);
  const beforeEpoch = database.prepare('SELECT epoch FROM runtime_meta').get();
  const beforeHistory = database.prepare('SELECT * FROM history').all();
  database.close();
  const beforeBytes = await fs.readFile(file);
  const reopened = f.open();
  await expect(new AgentRuntimeClient(reopened).status()).rejects.toThrow(/context|uniqueness|preserved|schema/i);
  await reopened.close();
  expect(await fs.readFile(file)).toEqual(beforeBytes);
  const after = new DatabaseSync(file, { readOnly: true });
  try {
    expect(after.prepare('SELECT epoch FROM runtime_meta').get()).toEqual(beforeEpoch);
    expect(after.prepare('SELECT * FROM history').all()).toEqual(beforeHistory);
  } finally { after.close(); }
});
