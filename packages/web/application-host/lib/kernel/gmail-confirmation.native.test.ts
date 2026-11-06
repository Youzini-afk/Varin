import { guardProviderReply } from './provider-response.test-helper.js';
import express from 'express';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { configureRuntimeUrlResolver, createThreadsHttpAPI, setRuntimeExtraHeaders } from '@varin/application-client';
import { registerCommonRequestMiddleware } from '../platform/core-routes.js';
import { AgentRuntimeClient } from './agent-runtime-client.js';
import { ExistingHostCredentialOwner } from './credential-owner.js';
import { createExtensionTools } from './extension-tool-owner.js';
import { createKernelClient } from './kernel-client.js';
import { ThreadAdapter } from './thread-adapter.js';
import { registerThreadRoutes } from './thread-routes.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
// The extension-host package already owns the esbuild development dependency.
const { build } = createRequire(path.join(repository, 'packages/extension-host/package.json'))('esbuild') as {
  build(options: Record<string, unknown>): Promise<unknown>;
};
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  setRuntimeExtraHeaders(null);
  configureRuntimeUrlResolver({ apiBaseUrl: '', realtimeBaseUrl: '' });
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback listener');
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return `http://127.0.0.1:${address.port}`;
}

it('requires a fresh exact Gmail confirmation through the real kernel, HTTP route and extension broker', async () => {
  await fs.access(kernelPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-gmail-confirmation-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const example = path.join(repository, 'examples/extensions/gmail');
  const source = path.join(root, 'extension'), sink = path.join(root, 'sent.jsonl');
  await fs.mkdir(path.join(source, 'dist'), { recursive: true });
  await Promise.all(['varin.extension.json', 'settings.css'].map(name => fs.copyFile(path.join(example, name), path.join(source, name))));
  const alias = { '@varin/extension-sdk': path.join(repository, 'packages/extension-sdk/dist/index.js') };
  // The real Gmail extension and manifest run in the broker. Only the outbound Gmail API is
  // replaced by a local file sink; this test cannot send email or access a real account.
  await build({ stdin: { resolveDir: example, sourcefile: 'fixture-host.mjs', contents: `
    import { appendFile } from 'node:fs/promises';
    import { createExtension } from './host.mjs';
    const client = { status: async () => ({}), search: async () => ({}), read: async () => ({}),
      send: async input => { await appendFile(${JSON.stringify(sink)}, JSON.stringify(input) + '\\n'); return { status: 'sent' }; } };
    const connection = { status: async () => ({}), start: async () => ({}), cancel: async () => ({}),
      check: async () => ({}), disconnect: async () => ({}), dispose: () => {} };
    export default createExtension(client, connection);
  ` }, outfile: path.join(source, 'dist/host.cjs'), bundle: true, platform: 'node', format: 'cjs', alias });
  await build({ entryPoints: [path.join(example, 'settings.mjs')], outfile: path.join(source, 'dist/settings.cjs'),
    bundle: true, platform: 'browser', format: 'cjs', alias });

  const kernel = createKernelClient({ hostId: 'gmail-confirmation', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  cleanups.push(() => kernel.close());
  const extensions = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: buildVersion,
    brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  cleanups.push(() => extensions.stop());
  const started = await extensions.start();
  await extensions.installOrStage({ expectedRevision: started.catalog.revision,
    source: { kind: 'local', display: 'Gmail confirmation fixture', specifier: source } });
  const runtime = new AgentRuntimeClient(kernel, undefined, undefined, undefined, undefined,
    createExtensionTools({ runtime: extensions, kernel, currentPolicy: async () => ({ mode: 'bypass', rules: [] }) }));

  const arguments_ = { to: ['recipient@example.test'], cc: ['copy@example.test'], subject: '确认主题', body: 'First line\nSecond line' };
  let requests = 0;
  const provider = createServer((request, response: ServerResponse) => {
    request.resume();
    request.on('end', guardProviderReply(response, () => {
      const output = ++requests <= 2
        ? [{ id: `send-${requests}`, type: 'function_call', call_id: `call-${requests}`, name: 'tool_invoke',
          arguments: JSON.stringify({ name: 'gmail_send', arguments: arguments_ }) }]
        : [{ id: 'done', type: 'message', content: [{ type: 'output_text', text: 'Done' }] }];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output } })}\n\n`);
    }));
  });
  const endpoint = `${await listen(provider)}/responses`;
  const credentialOwner = new ExistingHostCredentialOwner({ providerId: 'gmail-fixture', providerFamily: 'openai-responses', endpoint,
    currentScope: async () => ({ reference: 'fixture', authority: 'fixture', account: 'fixture', generation: 1 }),
    runtime: { getAuth: async () => ({ auth: { apiKey: 'fake-local-fixture-key' } }) } });
  const configuration = { providerFamily: 'openai-responses', model: 'gmail-fixture', endpoint, credentialEnvironment: null,
    allowAnonymous: false, configurationGeneration: 1, maxOutputTokens: 64 };
  const launchErrors: unknown[] = [];
  const adapter = new ThreadAdapter(runtime, { resolveModel: async () => ({ configuration, credentialOwner }), rebindModel: async () => credentialOwner },
    async () => { throw new Error('Fixture has no source'); }, (_run, error) => { launchErrors.push(error); });
  const app = express(); registerCommonRequestMiddleware(app, { express });
  registerThreadRoutes(app, adapter, (request, response, next) => {
    if (request.headers['x-fixture-auth'] !== 'gmail-fixture') { response.status(401).end(); return; }
    next();
  });
  const hostUrl = await listen(createServer(app));
  configureRuntimeUrlResolver({ apiBaseUrl: hostUrl, realtimeBaseUrl: hostUrl });
  setRuntimeExtraHeaders({ 'x-fixture-auth': 'gmail-fixture' });
  const api = createThreadsHttpAPI(), identity = await api.create('gmail-confirmation');
  const receipt = await api.submit({ ...identity, key: 'gmail-message', expectedHead: null, text: 'Send the specified email',
    model: { providerId: 'gmail-fixture', modelId: 'gmail-fixture' } });
  const waiting = async (except?: string) => {
    await expect.poll(async () => (await api.snapshot(identity)).operations.some(op => op.id !== except && op.waiting_on?.startsWith('permission:')), { timeout: 15_000 }).toBe(true);
    return (await api.snapshot(identity)).operations.find(op => op.id !== except && op.waiting_on?.startsWith('permission:'))!;
  };
  const permission = (operation: Awaited<ReturnType<typeof waiting>>) => {
    if (operation.result?.kind !== 'control') throw new Error('Expected permission control');
    return (operation.result.value as { permission: { id: string; call: { arguments: unknown }; scope: Record<string, unknown> } }).permission;
  };
  const first = await waiting(), firstPermission = permission(first);
  expect(firstPermission.call.arguments).toEqual(arguments_);
  expect(firstPermission.scope).toMatchObject({ confirmation: 'always', previewLabels: { to: '收件人 / To', body: '正文 / Message' } });
  await expect(fs.access(sink)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(api.decidePermission({ ...identity, operationId: first.id, permissionId: firstPermission.id, decision: 'allow_always' })).rejects.toMatchObject({ status: 400 });
  await api.decidePermission({ ...identity, operationId: first.id, permissionId: firstPermission.id, decision: 'allow_once' });
  const second = await waiting(first.id);
  expect(JSON.parse((await fs.readFile(sink, 'utf8')).trim())).toEqual(arguments_);
  await api.decidePermission({ ...identity, operationId: second.id, permissionId: permission(second).id, decision: 'deny' });
  await expect.poll(async () => (await api.run(receipt.run_id)).state, { timeout: 15_000 }).toBe('completed');
  expect((await fs.readFile(sink, 'utf8')).trim().split('\n')).toHaveLength(1);
  expect(launchErrors).toEqual([]);
}, 45_000);
