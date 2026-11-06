import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createKernelClient, type KernelClient } from './kernel-client.js';
import { ShutdownDeadline } from '../shutdown-runtime.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release', process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
let artifactPath = kernelPath;
let stagedDirectory: string | undefined;
const fixtureClients = new Set<KernelClient>();

beforeAll(async () => {
  await fs.access(kernelPath);
  const hasManifest = await fs.lstat(path.join(path.dirname(kernelPath), 'manifest.json')).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  });
  if (hasManifest) return;
  // The unified native runner can select a raw Cargo release binary (Windows
  // --build-only does not stage). This test also requires installed-artifact
  // validation, so stage that exact prebuilt binary using the production
  // packager. Do not compile another kernel or manufacture a test manifest.
  // An existing but invalid manifest must still fail the original validator.
  stagedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-native-stop-artifact-'));
  await promisify(execFile)(process.execPath, [path.join(repository, 'scripts/build-kernel.mjs'),
    '--stage', stagedDirectory, '--build-identity', buildVersion], {
    cwd: repository, env: { ...process.env, VARIN_KERNEL_PREBUILT: path.resolve(kernelPath) },
  });
  artifactPath = path.join(stagedDirectory, process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel');
});
afterAll(async () => {
  if ([...fixtureClients].some(client => {
    const child = lifetime(client).child;
    return child && child.exitCode === null && child.signalCode === null;
  })) throw new Error('Native shutdown fixture still owns a live process; retaining its staged artifact');
  if (stagedDirectory) await fs.rm(stagedDirectory, { recursive: true, force: true });
});

// Inspect process/transport lifetime, not a replacement implementation of their stop.
const lifetime = (client: KernelClient) => client as unknown as { child: ChildProcessWithoutNullStreams | null; transport: unknown };
const terminate = async (child: ChildProcessWithoutNullStreams | null) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  process.kill(child.pid!, 'SIGKILL');
  await exited;
};

async function verifyStopAndReopen(freeze: boolean) {
  await fs.access(kernelPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-native-stop-'));
  const clients: KernelClient[] = [];
  const open = async () => {
    const host = createKernelClient({ hostId: 'native-stop', storageRoot: root, buildVersion, kernelPath: artifactPath,
      requireKernelManifest: true, allowCargoDevRunner: false });
    clients.push(host);
    fixtureClients.add(host);
    await host.start();
    const grant = await host.issueGrant({ grantId: 'writer', owningWorkspace: 'workspace', executionWorkspace: 'workspace',
      capabilities: ['storage.read', 'storage.write'], pathScopes: [''] });
    return { host, grant, actor: host.scoped(grant) };
  };
  try {
    const { host, grant, actor } = await open();
    const body = Buffer.from('acknowledged before stop\n');
    const object = await actor.putBlob(body, 'body');
    await actor.createBranch({ operationId: 'branch', branchId: 'branch', workspaceId: 'workspace', draftBasePaths: [], captureScopes: [],
      entries: [{ path: 'body.txt', state: { kind: 'regular-file', objectHash: object.hash, byteLength: object.byteLength, mode: 0o644 }, ownerId: object.ownerId }] });
    // Open the original native workspace lifetime, without requiring an OS mount.
    await host.workspaceRequest('workspace.open', { branchId: 'branch' }, grant);
    const child = lifetime(host).child!;
    const transport = lifetime(host).transport;
    host.beginDraining();
    if (freeze) {
      // Only the test supervisor freezes/kills this test-owned child. Expiry in
      // KernelClient must leave it and its original transport intact.
      process.kill(child.pid!, 'SIGSTOP');
      const deadline = new ShutdownDeadline(150);
      const stopping = host.close(deadline);
      await expect(stopping).rejects.toMatchObject({ code: 'shutdown-incomplete', owner: 'kernel.native-drain', reason: 'deadline' });
      expect(lifetime(host).child).toBe(child);
      expect(lifetime(host).transport).toBe(transport);
      expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull(); expect(child.killed).toBe(false);
      expect(host.close(deadline)).toBe(stopping);
      await terminate(child);
    } else {
      await host.close(new ShutdownDeadline(5_000));
      expect(child.exitCode).toBe(0); expect(child.signalCode).toBeNull();
      expect(lifetime(host).child).toBeNull(); expect(lifetime(host).transport).toBeUndefined();
    }

    const reopened = await open();
    const read = await reopened.actor.getBlob(object.hash, { branchId: 'branch', path: 'body.txt' });
    expect(Buffer.from(read.bytesBase64, 'base64')).toEqual(body);
    expect((await reopened.actor.health({ deep: true })).integrity).toBe('ok');
    await reopened.host.close(new ShutdownDeadline(5_000));
  } finally {
    // Test cleanup never deletes a store while its native process remains live.
    for (const client of clients) await terminate(lifetime(client).child);
    await fs.rm(root, { recursive: true, force: true });
  }
}

it('drains a real native workspace within the shared stop budget and reopens committed data', () => verifyStopAndReopen(false), 20_000);
it.skipIf(process.platform === 'win32')('reports a frozen native owner as incomplete, retains it until supervisor termination, and reopens committed data', () => verifyStopAndReopen(true), 20_000);
