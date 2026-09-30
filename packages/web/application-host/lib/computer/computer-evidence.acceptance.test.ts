import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createKernelClient } from '../kernel/kernel-client.js';
import { createComputerService } from './computer-service.js';

it('persists computer steps in the real kernel, pages every seq and survives reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-computer-evidence-'));
  const repository = resolve(fileURLToPath(new URL('../../../../..', import.meta.url)));
  const version = (JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')) as { version: string }).version;
  const kernelPath = process.env.VARIN_TEST_KERNEL_PATH;
  if (!kernelPath) throw new Error('Run through scripts/test-kernel-authority.mjs');
  const start = async () => {
    const client = createKernelClient({ hostId: 'evidence-host', storageRoot: join(directory, 'kernel'), buildVersion: version,
      kernelPath, allowCargoDevRunner: false });
    await client.start();
    const service = createComputerService({ client, hostId: 'evidence-host', dataDir: directory, platform: 'windows',
      createDriver: () => ({ request: async () => ({ id: 'driver', ok: true, pid: 123 }),
        alive: () => true, cancel: () => true, dispose: () => undefined, capabilities: null }) });
    await service.ensureLocal();
    return { client, service };
  };
  let current = await start();
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => current.service.open({ desktopId: 'local-console',
      path: `private ${index}.txt`, sessionId: 'origin-session' })));
    const first = await current.service.evidence({ desktopId: 'local-console', since: 0, limit: 3 });
    expect(first.entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(first.hasMore).toBe(true);
    const second = await current.service.evidence({ desktopId: 'local-console', since: first.nextSince, limit: 10 });
    expect(second.entries.map((entry) => entry.seq)).toEqual([4, 5, 6, 7, 8]);
    expect(second.hasMore).toBe(false);
    expect(JSON.stringify([...first.entries, ...second.entries])).not.toContain('private');
    await current.service.dispose();
    await current.client.close();
    current = await start();
    expect((await current.service.evidence({ desktopId: 'local-console', since: 0, limit: 10 })).entries).toHaveLength(8);
    await current.service.open({ desktopId: 'local-console', path: 'later.txt' });
    expect((await current.service.evidence({ desktopId: 'local-console', since: 8 })).entries.map((entry) => entry.seq)).toEqual([9]);
    await expect(current.service.act({ desktopId: 'local-console', action: { kind: 'secret-selector', app: 'private' } as never }))
      .rejects.toThrow();
    const rejected = (await current.service.evidence({ desktopId: 'local-console', since: 9 })).entries;
    expect(rejected).toMatchObject([{ seq: 10, op: 'invalid', outcome: 'rejected' }]);
    expect(JSON.stringify(rejected)).not.toContain('secret-selector');
    await expect(current.service.evidence({ desktopId: 'local-console', since: 11 })).rejects.toThrow(/beyond/);
  } finally {
    await current.service.dispose(); await current.client.close(); await rm(directory, { recursive: true, force: true });
  }
});
