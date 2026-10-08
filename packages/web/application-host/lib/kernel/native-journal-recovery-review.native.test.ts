import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createKernelClient } from './kernel-client.js';
import { NativeRuntimeClient } from './native-runtime-client.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/debug/varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
function sql(filename: string, statement: string) {
  execFileSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.argv[2]); c.commit()', filename, statement]);
}
function tool(response: ServerResponse, name: string, args: unknown, serial: number) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: `item-${serial}`, type: 'function_call', call_id: `call-${serial}`, name, arguments: JSON.stringify(args) }] } })}\n\n`);
}

it('real file journal settles a lost native receipt after kernel restart without repeating the write', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-native-journal-review-'));
  const catalog = path.join(root, 'agent-runtime/conversation.sqlite');
  let child!: ChildProcess;
  const options = { hostId: 'journal-review', storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false };
  let host = createKernelClient({ ...options, spawnProcess: ((command, args, input) => { child = spawn(command, args ?? [], input ?? {}); return child; }) as typeof spawn });
  let native = new NativeRuntimeClient(host);
  let turn = 0;
  const observed: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { input: Array<Record<string, unknown>> };
      const last = body.input.findLast(item => item.type === 'function_call_output');
      if (last) observed.push(JSON.parse(String(last.output)));
      turn++;
      if (turn === 1) tool(response, 'native_file_read', { path: 'source.txt' }, turn);
      else if (turn === 2) {
        const read = observed.at(-1) as { content: { readVersion: string } };
        sql(catalog, "CREATE TRIGGER lose_native_receipt BEFORE UPDATE OF receipt ON tool_calls WHEN NEW.call_id='call-2' AND NEW.receipt IS NOT NULL BEGIN SELECT RAISE(ABORT,'review lost native receipt'); END;");
        tool(response, 'native_file_write', { path: 'source.txt', readVersion: read.content.readVersion, content: 'written exactly once\n' }, turn);
      } else {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ type: 'response.completed', response: { output: [{ id: 'final-answer', type: 'message', content: [{ type: 'output_text', text: 'recovered' }] }] } })}\n\n`);
      }
    });
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing local address');
    await host.start();
    const actor = host.scoped(await host.issueGrant({ grantId: 'source-owner', owningWorkspace: 'workspace', executionWorkspace: 'workspace', capabilities: ['storage.read', 'storage.write'], pathScopes: [''] }));
    const bytes = Buffer.from('before\n');
    const blob = await actor.putBlob(bytes, 'source-blob');
    await actor.createBranch({ operationId: 'create-source', branchId: 'source', workspaceId: 'workspace', draftBasePaths: [], captureScopes: [], entries: [{ path: 'source.txt', state: { kind: 'regular-file', objectHash: blob.hash, byteLength: bytes.length, mode: 0o644 }, ownerId: blob.ownerId }] });
    const branch = await actor.readBranch({ branchId: 'source' });
    const published = await actor.publishBranch({ operationId: 'publish-source', branchId: 'source', expectedRoot: branch.root, expectedWriteRevision: branch.writeRevision });
    await native.createThread('thread', 'conversation');
    const run = await native.submit({ key: 'input', threadId: 'thread', branchId: 'conversation', expectedHead: null, input: { text: 'write selected file' }, configuration: { providerFamily: 'openai-responses', model: 'fixture', endpoint: `http://127.0.0.1:${address.port}/responses`, allowAnonymous: true, configurationGeneration: 1, maxOutputTokens: 32 } });
    await native.startFromSource({ runId: run.run_id, workspaceId: 'workspace', executionWorkspaceId: 'workspace', branchId: 'source', revision: Number(published.revision), mode: 'materialized', tools: ['file_read', 'file_write'] });
    await expect.poll(async () => (await native.run(run.run_id)).state, { timeout: 10_000 }).toBe('waiting');
    expect(turn).toBe(2);
    const operation = (await native.events(0, 256)).find(event => event.kind === 'execution.committed' && JSON.stringify(event.data).includes('tool_dispatched'));
    expect(operation).toBeDefined();
    const paths = await fs.readdir(path.join(root, 'managed/native-runs'));
    const materializedFile = path.join(root, 'managed/native-runs', paths[0]!, 'source.txt');
    expect(await fs.readFile(materializedFile, 'utf8')).toBe('written exactly once\n');
    const before = await fs.stat(materializedFile, { bigint: true });
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; await host.close();
    sql(catalog, 'DROP TRIGGER lose_native_receipt;');
    host = createKernelClient(options); native = new NativeRuntimeClient(host);
    await native.rebindLaunch(run.run_id);
    await expect.poll(async () => (await native.run(run.run_id)).state, { timeout: 10_000 }).toBe('completed');
    expect(turn).toBe(3);
    expect(observed.at(-1)).toMatchObject({ outcome: 'succeeded', effect: 'confirmed' });
    expect(await fs.readFile(materializedFile, 'utf8')).toBe('written exactly once\n');
    expect((await fs.stat(materializedFile, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
    const results = (await native.history('conversation')).filter(item => JSON.stringify(item.content).includes('call-2') && item.source === 'tool');
    expect(results).toHaveLength(1);
  } finally {
    await host.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}, 40_000);
