import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareKernelCommand } from './kernel-launch.js';
import { KERNEL_PROTOCOL_VERSION } from './protocol.generated.js';

afterEach(() => vi.restoreAllMocks());

it('requires the installed manifest and validates the selected executable bytes for private modes too', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'varin-kernel-launch-'));
  try {
    const kernelPath = path.join(root, 'kernel');
    await fs.promises.writeFile(kernelPath, 'fixture executable');
    const options = { kernelPath, requireKernelManifest: true, kernelBuildIdentity: 'fixture' };
    await expect(prepareKernelCommand(options)).rejects.toMatchObject({ code: 'kernel-manifest-missing' });
    const manifest = { schema: 3, platform: process.platform, arch: process.arch, protocolVersion: KERNEL_PROTOCOL_VERSION,
      buildIdentity: 'fixture', sha256: createHash('sha256').update('fixture executable').digest('hex') };
    await fs.promises.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest));
    expect(await prepareKernelCommand(options)).toMatchObject({ command: kernelPath, args: [], manifest });
    await fs.promises.writeFile(kernelPath, 'changed executable');
    await expect(prepareKernelCommand(options)).rejects.toMatchObject({ code: 'kernel-manifest-mismatch' });
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

it('passes private-mode arguments through Cargo only when a development runner is allowed', async () => {
  vi.spyOn(fs, 'existsSync').mockImplementation(value => /[/\\]Cargo\.toml$/.test(String(value)));
  const command = await prepareKernelCommand({ allowCargoDevRunner: true, requireKernelManifest: false });
  expect(command.command).toBe(process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  expect(command.args.slice(-3)).toEqual(['--bin', 'varin-kernel', '--']);
  await expect(prepareKernelCommand({ allowCargoDevRunner: true, requireKernelManifest: true }))
    .rejects.toMatchObject({ code: 'kernel-manifest-missing' });
  await expect(prepareKernelCommand({ allowCargoDevRunner: false }))
    .rejects.toMatchObject({ code: 'kernel-entry-unavailable' });
});
