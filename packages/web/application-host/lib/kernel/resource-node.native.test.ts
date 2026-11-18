import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it as test } from 'vitest';
import { pairResourceNode, revokeResourceNodeClient, startResourceNode } from '../../resource-node.js';
import { toolOperationId } from './protocol.generated.js';
import type { ThreadPreparedSource } from '@varin/application-client';
import type { ManagedRemoteIdentity, ManagedSourceBinding, ManagedSourceReceipt, ManagedSourceResolveReceipt } from '../harness/managed-remote-types.js';

const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? fileURLToPath(new URL(
  '../../../../../kernel/target/release/' + (process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel'), import.meta.url));
const available = await fs.stat(kernelPath).then(() => true, () => false);
if (!available && process.env.VARIN_REQUIRE_RELEASE_KERNEL === '1') throw new Error('Resource node acceptance requires a release kernel');
const it = test.skipIf(!available);

it('pairs offline, serves an actual original live file and process, and reopens the same resource-only node', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-standalone-node-'));
  const workspaceRoot = path.join(dir, 'shared'), dataDir = path.join(dir, 'state');
  const options = { workspaceRoot, dataDir, port: 0, kernelPath, releaseId: 'test-artifact' };
  const creds = async (name: string, write: boolean, commands: boolean) => {
    const output = path.join(dir, name + '.json');
    await pairResourceNode({ ...options, output, write, commands });
    return JSON.parse(await fs.readFile(output, 'utf8')) as { token: string; clientId: string };
  };
  let node: Awaited<ReturnType<typeof startResourceNode>> | undefined;
  try {
    await fs.mkdir(workspaceRoot);
    await fs.writeFile(path.join(workspaceRoot, 'note.txt'), 'original node bytes');
    const reader = await creds('read', false, false), worker = await creds('work', true, true);
    node = await startResourceNode(options);
    const origin = () => 'http://127.0.0.1:' + node!.port;
    const api = (route: string, token?: string, input?: unknown) => fetch(origin() + '/api/harness/managed-execution/v1' + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const accepted = async <T = unknown>(request: Promise<Response>): Promise<T> => {
      const res = await request;
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(200);
      return body as T;
    };
    expect(await accepted(fetch(origin() + '/health'))).toEqual({ status: 'ok', role: 'resources', releaseId: 'test-artifact' });
    expect([401, 403]).toContain((await api('/identity')).status);
    const identity = await accepted<ManagedRemoteIdentity>(api('/identity', reader.token));
    expect(identity.capabilities).toContain('sources');
    for (const absent of ['remote-shell', 'storage', 'materials', 'attachment-stream']) expect(identity.capabilities).not.toContain(absent);
    expect((await api('/shell/exec', worker.token, {})).status).toBe(404);
    expect((await fetch(origin() + '/api/threads')).status).toBe(404);
    const coordinatorHostId = 'cloud-coordinator', threadId = 'thread:node', runId = 'run:node';
    const remote = { kind: 'managed_host', hostId: identity.hostId, connectionId: 'this-connection', endpointIdentity: 'this-endpoint' };
    const source = (name: string, token: string, body: object) => api('/sources/' + name, token, { coordinatorHostId, ...body });
    expect((await source('resolve', reader.token, { path: dataDir })).ok).toBe(false);
    const { workspaceId } = await accepted<ManagedSourceResolveReceipt>(source('resolve', reader.token, { path: workspaceRoot }));
    const prepare = async (token: string) => (await accepted<ThreadPreparedSource>(source('prepare', token, { input: {
      runtime: 'agent', threadId, branchId: 'main', key: randomUUID(), resourceOwner: remote,
      workspaceId, mode: 'live_root', content: { mode: 'saved-files' }, captureScopes: [],
    } }))).source;
    const readonly = await prepare(reader.token);
    expect(readonly.tools).toContain('file_read');
    expect(readonly.tools).not.toContain('file_write');
    expect(readonly.tools).not.toContain('process_spawn');
    const scope = { kind: 'run', threadId, runId, epoch: 1 };
    expect((await source('bind', reader.token, { source: { ...readonly, tools: ['file_write'] },
      scope, purpose: 'source', retention: 'run' })).ok).toBe(false);
    const prepared = await prepare(worker.token);
    expect(prepared.tools).toContain('process_spawn');
    expect(prepared.tools).not.toContain('code_retrieval');
    const { authorityId, resourceEpoch } = await accepted<ManagedSourceBinding>(source('bind', worker.token, {
      source: { ...prepared, tools: ['file_read', 'file_write', 'process_spawn'] }, scope, purpose: 'source', retention: 'run',
    }));
    const address = { authorityId, resourceEpoch };
    const execute = async (name: string, args: unknown) => {
      const callId = randomUUID(), origin = { kind: 'model_step' as const, request_id: 'request:node-native' };
      const call = { runId, callId, origin, operationId: toolOperationId(origin, callId), name, arguments: args, schemaVersion: '1' };
      await accepted(source('authorize', worker.token, { ...address, call }));
      return accepted<ManagedSourceReceipt>(source('execute', worker.token, { ...address, call }));
    };
    const { result } = await execute('file_read', { path: 'note.txt' });
    expect(result).toMatchObject({ completion: { outcome: 'succeeded', content: { data: { readVersion: expect.any(String) } } } });
    const read = (result as { completion: { content: { data: { content: { text: string }; readVersion: string } } } }).completion.content.data;
    expect(read.content.text).toBe('original node bytes');
    await execute('file_write', { path: 'note.txt', readVersion: read.readVersion, content: 'updated on node' });
    expect(await fs.readFile(path.join(workspaceRoot, 'note.txt'), 'utf8')).toBe('updated on node');
    const spawned = await execute('process_spawn', { cwd: '', command: process.execPath, mode: 'pipe',
      args: ['-e', 'require("node:fs").writeFileSync("process.txt", "ran on node")'] });
    expect(spawned.accepted).toBe(true);
    await expect.poll(async () => (await accepted<ManagedSourceReceipt>(source('observe', worker.token,
      { ...address, operationId: spawned.operationId }))).executorStopped).toBe(true);
    expect(await fs.readFile(path.join(workspaceRoot, 'process.txt'), 'utf8')).toBe('ran on node');
    await accepted(source('release', worker.token, { ...address, mode: 'retire' }));
    await node.close();
    await revokeResourceNodeClient(options, worker.clientId);
    node = await startResourceNode(options);
    expect((await accepted<ManagedRemoteIdentity>(api('/identity', reader.token))).hostId).toBe(identity.hostId);
    expect((await accepted<ManagedSourceResolveReceipt>(source('resolve', reader.token, { path: workspaceRoot }))).workspaceId).toBe(workspaceId);
    expect([401, 403]).toContain((await api('/identity', worker.token)).status);
    await expect(fs.stat(path.join(dataDir, 'kernel', node.hostId, 'agent-runtime'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await node?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 60_000);
