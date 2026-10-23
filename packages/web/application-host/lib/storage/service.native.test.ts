import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKernelClient } from '../kernel/kernel-client.js';
import { createStorageService } from './service.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const buildVersion = (JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8')) as { version: string }).version;
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, 'kernel/target/release/varin-kernel');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('confirms a Host preview against real Rust references, removes only its original hashes and replays the receipt', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'varin-storage-native-'));
  const kernel = createKernelClient({ hostId: 'storage-fixture', storageRoot: path.join(data, 'kernel'), buildVersion, kernelPath, allowCargoDevRunner: false });
  cleanups.push(async () => { await kernel.close(); await rm(data, { recursive: true, force: true }); });
  await kernel.start();
  const actor = kernel.scoped(await kernel.issueGrant({ grantId: 'fixture', owningWorkspace: 'workspace', executionWorkspace: 'workspace', pathScopes: [''], capabilities: ['storage.read', 'storage.write', 'storage.gc'] }));
  const first = await actor.putBlob(Buffer.from('selected body'), 'first');
  const protectedBody = Buffer.from('referenced again');
  const second = await actor.putBlob(protectedBody, 'second');
  await actor.releaseBlob(first.ownerId); await actor.releaseBlob(second.ownerId);
  const service = createStorageService({ hostId: 'storage-fixture', name: 'Native fixture', dataDirectory: data, speechModelsDirectory: path.join(data, 'speech-models'), kernel, devices: async () => [], workspaces: async () => [] });
  const preview = await service.preview({ kind: 'shared' });
  expect(preview.issues).toEqual([]);
  expect(preview.candidates).toHaveLength(1);
  expect(preview.candidates[0]?.count).toBe(2);
  const retained = await actor.putBlob(protectedBody, 'retain-again');
  const late = await actor.putBlob(Buffer.from('later unreferenced'), 'late'); await actor.releaseBlob(late.ownerId);
  const result = await service.cleanup(preview.id, preview.candidates.map(item => item.id));
  expect(result).toMatchObject({ state: 'complete', bytesReclaimed: 13, objectsDeleted: 1, failures: [] });
  expect(await service.cleanup(preview.id, preview.candidates.map(item => item.id))).toEqual(result);
  expect(Buffer.from((await actor.getBlob(retained.hash, { ownerId: retained.ownerId })).bytesBase64, 'base64')).toEqual(protectedBody);
  const remaining = await kernel.health({ gcPreview: true });
  expect(remaining.gcPreview?.objects.map(item => item.hash)).toEqual([late.hash]);
  expect((await kernel.health({ deep: true })).integrity).toBe('ok');
});
