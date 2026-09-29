import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareVmGuestSeed } from './vm-guest-seed.js';

it('builds a NoCloud seed from exact-version verified runtime assets', async () => {
  const driverDir = await mkdtemp(join(tmpdir(), 'varin-guest-bundle-'));
  try {
    const linux = join(driverDir, 'linux');
    const bundle = join(linux, 'guest-bundle-x64');
    await mkdir(bundle, { recursive: true });
    const digests: Record<string, string> = {};
    for (const [name, file] of [['runtime', 'runtime.tgz'], ['node', 'node'], ['bun', 'bun']] as const) {
      const bytes = Buffer.from(name);
      await writeFile(join(bundle, file), bytes);
      digests[name] = createHash('sha256').update(bytes).digest('hex');
    }
    await writeFile(join(linux, 'guest-init.sh'), '#!/bin/bash\n');
    await writeFile(join(linux, 'guest-upgrade.sh'), '#!/bin/bash\n');
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ schemaVersion: 1, architecture: 'x64',
      version: '0.9.21', sourceRevision: 'test', digests }));
    let command: string[] = [];
    const seed = await prepareVmGuestSeed({ driverDir, domainUuid: '00000000-0000-0000-0000-000000000001',
      password: 'guest_secret', expectedVersion: '0.9.21', exec: async (_command, args) => {
        command = args;
        await writeFile(args[args.indexOf('-output') + 1]!, 'iso fixture');
        return { code: 0, stdout: '', stderr: '' };
      } });
    expect(command).toContain('cidata');
    const userData = command.find((arg) => arg.startsWith('user-data='))!.slice('user-data='.length);
    expect(await readFile(userData, 'utf8')).toContain('guest-init.sh');
    const checksum = command.find((arg) => arg.startsWith('bundle.sha256='))!.slice('bundle.sha256='.length);
    expect(await readFile(checksum, 'utf8')).toContain(`${digests.runtime}  runtime.tgz`);
    expect(seed.runtimeSha256).toBe(digests.runtime);
    await seed.cleanup();
    await expect(readFile(seed.isoFile)).rejects.toThrow();
  } finally { await rm(driverDir, { recursive: true, force: true }); }
});
