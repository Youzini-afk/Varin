import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createLinuxDesktop } from './linux-desktop.js';
import type { VmExec } from './vm-provider.js';

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

it('keeps an unprepared Host read only and coalesces concurrent explicit preparation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'varin-linux-desktop-'));
  temporary.push(dataDir);
  let complete!: (value: { code: number; stdout: string; stderr: string }) => void;
  const commands: Array<{ command: string; args: string[] }> = [];
  const exec: VmExec = (command, args) => {
    commands.push({ command, args });
    return new Promise((resolve) => { complete = resolve; });
  };
  const desktop = createLinuxDesktop({ dataDir, driverDir: '/drivers', platform: 'linux', exec });
  expect(await desktop.status()).toEqual({ state: 'unprepared' });
  const first = desktop.change('prepare', { width: 1440, height: 900 });
  const second = desktop.change('prepare', { width: 1440, height: 900 });
  expect(commands).toEqual([{ command: 'sh', args: [join('/drivers', 'linux', 'prepare-desktop.sh'), '--data-dir', join(dataDir, 'computer-desktop'), '--width', '1440', '--height', '900'] }]);
  complete({ code: 0, stdout: '{"state":"running","socket":"/run/view.sock","driver":"/driver.py","artifact":"/artifact.py","home":"/home/desktop","user":"desktop","uid":1001,"environment":{},"width":1440,"height":900}\n', stderr: '' });
  expect(await first).toEqual(await second);
  await desktop.dispose();
});

it('reports an unreadable component result and does not erase a corrupt saved setup', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'varin-linux-desktop-'));
  temporary.push(dataDir);
  const folder = join(dataDir, 'computer-desktop');
  await mkdir(folder);
  await writeFile(join(folder, 'config.json'), '{incomplete');
  const desktop = createLinuxDesktop({ dataDir, driverDir: '/drivers', platform: 'linux', exec: async () => ({ code: 1, stdout: '{"state":"failed","detail":"invalid saved configuration"}\n', stderr: '' }) });
  await expect(desktop.status()).rejects.toThrow('invalid saved configuration');
});

it('serializes different component requests without substituting the first result', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'varin-install-'));
  temporary.push(dataDir);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const installed: string[] = [];
  let started!: () => void;
  const starting = new Promise<void>((resolve) => { started = resolve; });
  const desktop = createLinuxDesktop({ dataDir, driverDir: '/drivers', platform: 'linux', exec: async (_command, args) => {
    const group = args[args.indexOf('--group') + 1]!;
    installed.push(group);
    if (group === 'dev') { started(); await gate; }
    return { code: 0, stdout: JSON.stringify({ results: [{ id: group, state: 'installed' }] }), stderr: '' };
  } });
  const first = desktop.install({ groups: ['dev'] });
  const second = desktop.install({ groups: ['docs'] });
  await starting;
  expect(installed).toEqual(['dev']);
  finish();
  expect((await first)[0]?.id).toBe('dev');
  expect((await second)[0]?.id).toBe('docs');
  expect(installed).toEqual(['dev', 'docs']);
  await desktop.dispose();
});

it('projects bootstrap software state while distinguishing malformed state', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'varin-software-state-'));
  temporary.push(dataDir);
  const data = join(dataDir, 'computer-desktop');
  await mkdir(data);
  await writeFile(join(data, 'config.json'), '{}');
  await writeFile(join(data, 'software.status.json'), JSON.stringify({ results: [{ id: 'docs', state: 'installed', at: 10, packages: ['libreoffice-calc'] }] }));
  const desktop = createLinuxDesktop({ dataDir, driverDir: '/drivers', platform: 'linux', exec: async () => ({ code: 0, stdout: '{"state":"stopped"}', stderr: '' }) });
  expect((await desktop.status()).software).toEqual({ docs: { state: 'installed', at: 10, packages: ['libreoffice-calc'] } });
  await writeFile(join(data, 'software.status.json'), '{broken');
  await expect(desktop.status()).rejects.toThrow();
});
