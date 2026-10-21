import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createKernelClient } from '../kernel/kernel-client.js';
import { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { ExistingHostCredentialOwner } from '../kernel/credential-owner.js';
import { modelCredentialBindingIdentity } from '../kernel/model-binding-lifetime.js';
import { createModelTextService } from './service.js';
import { createThreadTitleService } from './thread-titles.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')).version as string;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-title-native-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const requests: Array<{ model: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: 'title', type: 'message', content: [{ type: 'output_text', text: '仓库启动流程分析' }] }] } })}\n\n`);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test listener');
  const endpoint = `http://127.0.0.1:${address.port}/responses`;
  const kernel = createKernelClient({ hostId: 'title-test', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  cleanups.push(() => kernel.close());
  const runtime = new AgentRuntimeClient(kernel);
  const models = { resolveModel: async (selection: { providerId: string; modelId: string }) => {
    const configuration = { providerId: selection.providerId, providerFamily: 'openai-responses', model: selection.modelId,
      endpoint, credentialEnvironment: null, allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 1024 };
    const credentialOwner = new ExistingHostCredentialOwner({ providerId: selection.providerId, providerFamily: configuration.providerFamily,
      endpoint, bindingIdentity: modelCredentialBindingIdentity(configuration),
      currentScope: async () => ({ reference: 'fixture', authority: 'host', account: 'fixture-account', generation: 1 }),
      runtime: { getAuth: async () => ({ auth: { apiKey: 'fixture-not-a-real-key' } }) },
    });
    return { configuration, credentialOwner, acceptsImages: false };
  } } as unknown as Parameters<typeof createModelTextService>[0]['models'];
  const modelText = createModelTextService({ kernel, runtime, models,
    readSettings: async () => ({ utilityModel: { providerId: 'auxiliary', modelId: 'auxiliary-title-model' }, defaultProvider: 'main', defaultModel: 'main-chat-model' }),
  });
  cleanups.push(() => modelText.close());
  const errors: unknown[] = [];
  const titles = createThreadTitleService({ runtime, modelText, onError: error => errors.push(error) });
  cleanups.push(() => titles.close());
  await runtime.createThread('conversation', 'conversation-main');
  const before = await runtime.thread('conversation');
  const text = '帮我分析这个仓库的启动流程\n需要理解配置和入口';
  await runtime.submit({ key: 'first-input', threadId: 'conversation', branchId: 'conversation-main', expectedHead: null, input: { text },
    configuration: { providerFamily: 'openai-responses', model: 'main-chat-model', endpoint, credentialEnvironment: null, allowAnonymous: true, configurationGeneration: 1, maxOutputTokens: 1024 } });
  return { kernel, runtime, titles, modelText, models, before, text, errors, requests };
}

it('dispatches the configured auxiliary model and persists its title through real native IPC', async () => {
  const f = await fixture();
  f.titles.schedule(f.before, f.text);
  await expect.poll(async () => ({ requests: f.requests.length, failures: f.errors.map(String),
    status: await f.modelText.inspect('model-text:thread-title:conversation').catch(() => null) }), { timeout: 3000 }).toMatchObject({ requests: 1, failures: [] });
  await expect.poll(async () => (await f.runtime.thread('conversation')).title).toBe('仓库启动流程分析');
  expect(f.requests[0]?.model).toBe('auxiliary-title-model');
  expect(f.errors).toEqual([]);
});

it.each([false, true])('recovers an originally unsent title without overwriting a manual rename (%s)', async renamed => {
  const f = await fixture();
  const model = await f.models.resolveModel({ providerId: 'auxiliary', modelId: 'original-auxiliary' });
  try {
    await f.kernel.agentRuntimeRequest('runtime.model_text.admit', { key: 'thread-title:conversation', requestFingerprint: 'original-unsent-title', retryOf: null,
      generation: { parentOperationId: 'model-text:thread-title:conversation', callerOwner: { kind: 'external', identity: 'model.text.v1', epoch: 'old-host' },
        ordinal: 1, configuration: model.configuration, credentialScope: await model.credentialOwner.scope(), purpose: 'title',
        systemPrompt: 'Return a concise title.', user: f.text } });
  } finally { model.credentialOwner.release(); }
  await f.kernel.agentRuntimeRequest('runtime.model_text.cancel', { requestId: 'model-text:thread-title:conversation' });
  if (renamed) {
    const current = await f.runtime.thread('conversation');
    await f.runtime.updateThread({ threadId: current.thread_id, expectedRevision: current.revision, key: 'manual-title', title: '我自己的标题' });
  }
  await f.titles.recover();
  expect((await f.runtime.thread('conversation')).title).toBe(renamed ? '我自己的标题' : '仓库启动流程分析');
  expect(f.requests).toHaveLength(renamed ? 0 : 1);
  if (!renamed) expect(f.requests[0]?.model).toBe('auxiliary-title-model');
  await f.titles.recover();
  expect(f.requests).toHaveLength(renamed ? 0 : 1);
  expect(f.errors).toEqual([]);
});
