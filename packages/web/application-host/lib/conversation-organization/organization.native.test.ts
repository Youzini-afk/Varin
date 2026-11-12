import { registerThreadRoutes } from '../kernel/thread-routes.js';
import { withRequestPrincipal } from '../kernel/request-principal.js';
import express from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { configureRuntimeUrlResolver, createConversationOrganizationHttpAPI, createThreadsHttpAPI } from '@varin/application-client';
import { createKernelClient } from '../kernel/kernel-client.js';
import { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { ThreadAdapter } from '../kernel/thread-adapter.js';
import { ConversationOrganizationService } from './service.js';
import { registerConversationOrganizationRoutes } from './routes.js';
import { registerCommonRequestMiddleware } from '../platform/core-routes.js';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as {version:string}).version;
it('round trips authenticated organization commands through the real kernel and reopens original placement', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-organization-http-'));
  const launch = () => createKernelClient({ hostId: 'organization-review', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  let kernel = launch();
  const runtime = new AgentRuntimeClient(kernel);
  const unused = async (): Promise<never> => { throw new Error('This metadata test must not prepare execution'); };
  const threads = new ThreadAdapter(runtime, { resolveModel: unused, rebindModel: unused }, unused, unused);
  const service = new ConversationOrganizationService({ runtime, threads, external: { list: async () => [], inspect: unused, update: unused }, readSettings: async () => ({ projects: [] }) });
  threads.bindOrganizationCreation((identity, placement) => service.creationDefaults('alice', identity.threadId, placement));
  const app = express(); registerCommonRequestMiddleware(app, { express });
  registerThreadRoutes(app, threads, (_req, _res, next) => withRequestPrincipal('alice', next));
  registerConversationOrganizationRoutes(app, service, (_req, _res, next) => next(), async () => ({ principalId: 'alice' }));
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected TCP fixture');
  configureRuntimeUrlResolver({ apiBaseUrl: `http://127.0.0.1:${address.port}`, realtimeBaseUrl: `http://127.0.0.1:${address.port}` });
  try {
    const api = createConversationOrganizationHttpAPI();
    await runtime.createThread('thread:legacy-public', 'branch:legacy-public', undefined, null);
    const initial = await api.read(); expect(initial.initialized).toBe(true);
    expect(initial.conversations.map(entry => entry.conversation.id)).toEqual(['thread:legacy-public']);
    expect((await runtime.thread('thread:legacy-public')).principal_id).toBeNull();
    const command = { key: 'create-group', operation: { action: 'create' as const, id: 'group', kind: 'group' as const, parentId: null, name: 'Release', parents: [{ containerId: null, childrenRevision: initial.rootRevision }] } };
    const receipt = await api.command(command); expect(await api.command(command)).toEqual(receipt);
    const organized = await createThreadsHttpAPI().create('organized', { organization: { containerId: 'group' } });
    expect(await createThreadsHttpAPI().create('organized', { organization: { containerId: 'group' } })).toEqual(organized);
    await runtime.createThread('thread:other-user', 'branch:other-user', undefined, 'bob');
    const current = await api.read(); expect(current.conversations.map(item => item.conversation.id).sort()).toEqual([organized.threadId, 'thread:legacy-public'].sort());
    const organizedEntry = current.conversations.find(entry => entry.conversation.id === organized.threadId)!;
    expect(organizedEntry.position.containerId).toBe('group');
    // Details can open without loading the navigation page that contains them.
    expect((await api.read({ pageNodes: true, rootOnly: true })).conversations.map(entry => entry.conversation.id)).toEqual(['thread:legacy-public']);
    expect(await api.entry({ kind: 'native', id: organized.threadId })).toEqual(organizedEntry);
    await expect(api.entry({ kind: 'native', id: 'thread:other-user' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(api.entry({ kind: 'external', id: organized.threadId })).rejects.toMatchObject({ code: 'not_found' });
    const metadata = await api.metadata({ key: 'archive', items: [{ conversation: {kind:'native',id:organized.threadId}, expectedRevision: organizedEntry.revision, patch: { archived: true } }] });
    expect(metadata.items[0]?.status).toBe('succeeded'); expect((await api.read()).conversations.map(entry => entry.conversation.id)).toEqual(['thread:legacy-public']);
    expect((await api.entry({ kind: 'native', id: organized.threadId })).archived).toBe(true);
    await kernel.close(); kernel = launch();
    const reopened = new AgentRuntimeClient(kernel);
    const saved = await reopened.organizationRead('alice', { archived: 'include' });
    expect(saved.conversations.find(entry => entry.conversation.id === organized.threadId)).toMatchObject({ conversation: {kind:'native',id:organized.threadId}, archived:true, position: {containerId:'group'} });
    expect(await reopened.organizationCommand('alice', command)).toEqual(receipt);
    await reopened.createThread('thread:receipt', 'branch:receipt', undefined, 'alice');
    const admission = { key: 'accepted-input', threadId: 'thread:receipt', branchId: 'branch:receipt', expectedHead: null,
      input: { text: 'Original input' }, configuration: { providerId: 'fixture', providerFamily: 'openai-responses',
        model: 'fixture-model', endpoint: 'http://127.0.0.1:1/responses', credentialEnvironment: null,
        allowAnonymous: true, configurationGeneration: 1, maxOutputTokens: 64 },
      launch: { inheritSource: true, source: null, enabledTools: [] } };
    expect(await reopened.inheritedInputReceipt(admission)).toBeNull();
    const accepted = await reopened.submit(admission);
    expect(await reopened.inheritedInputReceipt(admission)).toEqual(accepted);
    await expect(reopened.inheritedInputReceipt({ ...admission, input: { text: 'Changed user intent' } })).rejects.toThrow();
    await kernel.agentRuntimeRequest('runtime.bot.gate.publish', { botId: 'scope-bot', profileRevision: 1, activityOperationId: null, permitted: true });
    await reopened.createBotThread('scope-bot', 'thread:alice-bot', 'branch:alice-bot', undefined, undefined, 'alice');
    await reopened.createBotThread('scope-bot', 'thread:bob-bot', 'branch:bob-bot', undefined, undefined, 'bob');
    expect((await reopened.botScope('scope-bot', undefined, true, 'alice')).sessions).toEqual(['thread:alice-bot']);
    // Explicit public null must survive the generated wire decoder. It must never
    // become the omitted principal used only by the whole-Bot lifecycle owner.
    expect((await reopened.botScope('scope-bot', undefined, true, null)).sessions).toEqual([]);
    expect((await reopened.botScope('scope-bot', undefined, true)).sessions.sort()).toEqual(['thread:alice-bot', 'thread:bob-bot']);


  } finally {
    configureRuntimeUrlResolver({ apiBaseUrl: '', realtimeBaseUrl: '' }); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await kernel.close(); await fs.rm(root, { recursive: true, force: true });
  }
});
