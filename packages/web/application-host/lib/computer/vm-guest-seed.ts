import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VmExec } from './vm-provider.js';
import { HarnessServiceError } from '../harness/service-error.js';

interface GuestBundleManifest {
  schemaVersion: number;
  architecture: string;
  version: string;
  sourceRevision: string | null;
  digests: { runtime: string; node: string; bun: string };
}

const hashFile = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};

export async function prepareVmGuestSeed(input: {
  driverDir: string;
  domainUuid: string;
  password: string;
  expectedVersion: string;
  exec: VmExec;
}): Promise<{ isoFile: string; runtimeSha256: string; bundleVersion: string; cleanup(): Promise<void> }> {
  const bundle = join(input.driverDir, 'linux', 'guest-bundle-x64');
  let manifest: GuestBundleManifest;
  try { manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')) as GuestBundleManifest; }
  catch { throw new HarnessServiceError('unavailable', 'This Host distribution has no Linux x64 VM guest runtime'); }
  if (!manifest || manifest.schemaVersion !== 1 || manifest.architecture !== 'x64' || manifest.version !== input.expectedVersion
    || !manifest.digests || ['runtime', 'node', 'bun'].some((name) => !/^[0-9a-f]{64}$/u.test(manifest.digests[name as keyof typeof manifest.digests]))) {
    throw new HarnessServiceError('unavailable', 'VM guest runtime does not match this Host version');
  }
  for (const [name, filename] of [['runtime', 'runtime.tgz'], ['node', 'node'], ['bun', 'bun']] as const) {
    const actual = await hashFile(join(bundle, filename)).catch(() => '');
    if (actual !== manifest.digests[name]) throw new HarnessServiceError('unavailable', `VM guest bundle asset failed verification: ${filename}`);
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(input.password)) throw new HarnessServiceError('invalid-params', 'VM guest credential is invalid');
  const folder = await mkdtemp(join(tmpdir(), 'varin-guest-seed-'));
  try {
    const isoFile = join(folder, 'seed.iso');
    const command = 'mkdir -p /mnt/varin-seed && mount -o ro "$(blkid -L cidata || blkid -L CIDATA)" /mnt/varin-seed && bash /mnt/varin-seed/guest-init.sh';
    await Promise.all([
      writeFile(join(folder, 'user-data'), `#cloud-config\ngrowpart:\n  mode: auto\n  devices: ['/']\nresize_rootfs: true\nruncmd:\n  - [ bash, -lc, ${JSON.stringify(command)} ]\n`, { mode: 0o600 }),
      writeFile(join(folder, 'meta-data'), `instance-id: varin-${input.domainUuid}\nlocal-hostname: varin-${input.domainUuid.slice(0, 8)}\n`),
      writeFile(join(folder, 'guest.env'), `VARIN_UI_PASSWORD=${input.password}\nVARIN_DATA_DIR=/var/lib/varin\nNODE_ENV=production\n`, { mode: 0o600 }),
      copyFile(join(input.driverDir, 'linux', 'guest-init.sh'), join(folder, 'guest-init.sh')),
      copyFile(join(input.driverDir, 'linux', 'guest-upgrade.sh'), join(folder, 'guest-upgrade.sh')),
      writeFile(join(folder, 'bundle.sha256'), ['runtime', 'node', 'bun'].map((name) =>
        `${manifest.digests[name as keyof typeof manifest.digests]}  ${name === 'runtime' ? 'runtime.tgz' : name}`).join('\n') + '\n'),
    ]);
    const entries = ['user-data', 'meta-data', 'guest.env', 'guest-init.sh', 'guest-upgrade.sh', 'bundle.sha256', 'runtime.tgz', 'node', 'bun'];
    const paths = entries.map((name) => `${name}=${['runtime.tgz', 'node', 'bun'].includes(name) ? join(bundle, name) : join(folder, name)}`);
    const result = await input.exec('genisoimage', ['-quiet', '-output', isoFile, '-volid', 'cidata', '-joliet', '-rock', '-graft-points', ...paths]);
    const built = await stat(isoFile).catch(() => null);
    if (result.code !== 0 || !built || built.size === 0) {
      throw new HarnessServiceError('unavailable', result.stderr.trim() || 'NoCloud seed ISO was not created');
    }
    return { isoFile, runtimeSha256: manifest.digests.runtime, bundleVersion: manifest.version,
      cleanup: () => rm(folder, { recursive: true, force: true }) };
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}
