import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRemoteClientAuthRuntime } from './lib/client-auth/remote-clients.js';
import { KernelClient } from './lib/kernel/kernel-client.js';
import { createPrincipalStore } from './lib/ui-auth/principals.js';
import { pairResourceNode, revokeResourceNodeClient, startResourceNode } from './resource-node.js';

afterEach(() => { vi.restoreAllMocks(); });

it('fails before kernel startup on ambiguous paths, overlapping roots, restore fences or exposed bearer files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-node-fence-'));
  const workspaceRoot = path.join(dir, 'selected'), dataDir = path.join(dir, 'private');
  const start = vi.spyOn(KernelClient.prototype, 'start').mockRejectedValue(new Error('unexpected kernel start'));
  try {
    await fs.mkdir(workspaceRoot);
    await expect(startResourceNode({ workspaceRoot: '.', dataDir })).rejects.toThrow('absolute');
    await expect(startResourceNode({ workspaceRoot, dataDir: path.join(workspaceRoot, 'keys') })).rejects.toThrow('disjoint');
    await fs.symlink(workspaceRoot, dataDir, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(startResourceNode({ workspaceRoot, dataDir })).rejects.toThrow('disjoint');
    await fs.unlink(dataDir);
    await expect(pairResourceNode({ workspaceRoot, dataDir, output: path.join(workspaceRoot, 'client') })).rejects.toThrow('private');
    await expect(pairResourceNode({ workspaceRoot, dataDir, output: path.join(dataDir, 'client') })).rejects.toThrow('private');
    await fs.writeFile(path.join(dataDir, '.varin-offline-restore.json'), '{}');
    await expect(startResourceNode({ workspaceRoot, dataDir })).rejects.toThrow('fenced');
    expect(start).not.toHaveBeenCalled();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

it('mints only the chosen rights into the existing bearer store while the operator holds exclusive state ownership', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-node-pair-'));
  const workspaceRoot = path.join(dir, 'work'), dataDir = path.join(dir, 'state'), output = path.join(dir, 'secret');
  // This suite exercises real files, original identity and auth owners. Native acceptance additionally
  // obtains the actual kernel writer lock and serves requests with this credential.
  const start = vi.spyOn(KernelClient.prototype, 'start').mockRejectedValueOnce(new Error('storage is owned by another Host'))
    .mockResolvedValue({} as Awaited<ReturnType<KernelClient['start']>>);
  const verify = async (token: string) => {
    const clients = createRemoteClientAuthRuntime({ fsPromises: fs, crypto, path, storePath: path.join(dataDir, 'remote-clients.json'),
      principals: createPrincipalStore(path.join(dataDir, 'ui-principals.json')) });
    try { return await clients.authenticateBearerToken(token); } finally { await clients.dispose(); }
  };
  try {
    await fs.mkdir(workspaceRoot);
    await expect(pairResourceNode({ workspaceRoot, dataDir, output })).rejects.toThrow('another Host');
    await expect(fs.stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    const id = await pairResourceNode({ workspaceRoot, dataDir, output });
    const raw = await fs.readFile(output, 'utf8'), { token } = JSON.parse(raw);
    expect(await verify(token)).toMatchObject({ clientId: id, client: { capabilities: ['filesystem:read'], allowedDirectories: [await fs.realpath(workspaceRoot)] } });
    if (process.platform !== 'win32') expect((await fs.stat(output)).mode & 0o077).toBe(0);
    await expect(pairResourceNode({ workspaceRoot, dataDir, output, commands: true })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(output, 'utf8')).toBe(raw);
    expect(await fs.readFile(path.join(dataDir, 'remote-clients.json'), 'utf8')).not.toContain(token);
    await revokeResourceNodeClient({ workspaceRoot, dataDir }, id!);
    expect(await verify(token)).toBeNull();
    expect(start).toHaveBeenCalledTimes(4);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
