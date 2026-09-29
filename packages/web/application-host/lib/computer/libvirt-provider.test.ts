import { describe, expect, it } from 'vitest';
import { createLibvirtProvider } from './libvirt-provider.js';
import { libvirtFixture } from './libvirt.test-helper.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = { id: 'hv1', kind: 'libvirt' as const, uri: 'qemu:///system' };
const spec = { name: 'alpha', memoryMiB: 2048, vcpus: 2, diskGiB: 20, domainUuid: '9f8e7d6c-1111-2222-3333-444455556666' };
const volume = `varin-${spec.domainUuid}.qcow2`;

describe('libvirt creation authority', () => {
  it('stages a verified cloud image only under this VM UUID with a durable allocation receipt', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'varin-base-'));
    try {
      const file = join(folder, 'base.qcow2');
      const qcow = Buffer.alloc(64);
      qcow.write('QFI', 0, 'ascii'); qcow[3] = 0xfb;
      qcow.writeBigUInt64BE(2n * 1024n * 1024n * 1024n, 24);
      await writeFile(file, qcow);
      const fixture = libvirtFixture();
      const provider = createLibvirtProvider(config, fixture.exec);
      const volumePaths: string[] = [];
      const name = await provider.stageBaseImage!({ domainUuid: spec.domainUuid, file, volumePaths, uploaded: false,
        checkpoint: async (paths) => { volumePaths.splice(0, volumePaths.length, ...paths); } });
      expect(name).toBe(`varin-${spec.domainUuid}-base.qcow2`);
      expect(volumePaths).toEqual([name]);
      expect(fixture.calls.map((call) => call.args[0])).toContain('vol-upload');
      await provider.stageBaseImage!({ domainUuid: spec.domainUuid, file, volumePaths, uploaded: true, checkpoint: async () => {} });
      expect(fixture.calls.filter((call) => call.args[0] === 'vol-upload')).toHaveLength(1);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it('reuses a receipted image volume and uploads again after an uncertain upload response', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'varin-base-retry-'));
    try {
      const file = join(folder, 'base.qcow2');
      const qcow = Buffer.alloc(64);
      qcow.write('QFI', 0, 'ascii'); qcow[3] = 0xfb;
      qcow.writeBigUInt64BE(2n * 1024n * 1024n * 1024n, 24);
      await writeFile(file, qcow);
      const fixture = libvirtFixture();
      fixture.faults.set('vol-upload', 'after');
      const provider = createLibvirtProvider(config, fixture.exec);
      let receipt: string[] = [];
      await expect(provider.stageBaseImage!({ domainUuid: spec.domainUuid, file, volumePaths: receipt,
        uploaded: false, checkpoint: async (paths) => { receipt = paths; } })).rejects.toThrow();
      expect(receipt).toEqual([`varin-${spec.domainUuid}-base.qcow2`]);
      fixture.faults.delete('vol-upload');
      await provider.stageBaseImage!({ domainUuid: spec.domainUuid, file, volumePaths: receipt,
        uploaded: false, checkpoint: async (paths) => { receipt = paths; } });
      expect(fixture.calls.filter((call) => call.args[0] === 'vol-create-as')).toHaveLength(1);
      expect(fixture.calls.filter((call) => call.args[0] === 'vol-upload')).toHaveLength(2);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it('attaches an owned NoCloud seed as a read-only CD-ROM and journals its upload', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'varin-seed-'));
    try {
      const seedIsoFile = join(folder, 'seed.iso');
      await writeFile(seedIsoFile, Buffer.from('seed fixture'));
      const fixture = libvirtFixture();
      const receipts: string[][] = [];
      const provider = createLibvirtProvider(config, fixture.exec);
      const outcome = await provider.create({ ...spec, seedIsoFile, checkpoint: async (receipt) => { receipts.push([...receipt.volumePaths]); } });
      const seedVolume = `varin-${spec.domainUuid}-seed.iso`;
      expect(outcome.ok).toBe(true);
      expect(outcome.volumePaths).toEqual([volume, seedVolume]);
      expect(receipts).toEqual([[volume], [volume, seedVolume], [volume, seedVolume]]);
      expect(fixture.calls.find((call) => call.args[0] === 'define')?.stdin).toContain(`<readonly/>`);
      expect(fixture.calls.find((call) => call.args[0] === 'vol-upload')?.args).toEqual(['vol-upload', seedVolume, seedIsoFile, '--pool', 'default']);
      await provider.delete(spec.domainUuid, outcome.volumePaths, true);
      expect(fixture.volumes.size).toBe(0);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it('upgrades only a stopped guest seed and can retry a lost upload response', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'varin-seed-upgrade-'));
    try {
      const seedIsoFile = join(folder, 'seed.iso');
      await writeFile(seedIsoFile, Buffer.from('new seed fixture'));
      const fixture = libvirtFixture();
      const exec = async (...args: Parameters<typeof fixture.exec>) => {
        if (args[1][2] === 'vol-info') return { code: 0, stdout: 'Capacity: 2\n', stderr: '' };
        return fixture.exec(...args);
      };
      const provider = createLibvirtProvider(config, exec);
      const outcome = await provider.create({ ...spec, seedIsoFile });
      await provider.start(spec.domainUuid);
      await expect(provider.upgradeSeed!({ domainUuid: spec.domainUuid, isoFile: seedIsoFile,
        volumePaths: outcome.volumePaths })).rejects.toThrow(/Shut down/);
      await provider.shutdown(spec.domainUuid);
      fixture.faults.set('vol-upload', 'after');
      await expect(provider.upgradeSeed!({ domainUuid: spec.domainUuid, isoFile: seedIsoFile,
        volumePaths: outcome.volumePaths })).rejects.toThrow();
      fixture.faults.delete('vol-upload');
      await provider.upgradeSeed!({ domainUuid: spec.domainUuid, isoFile: seedIsoFile,
        volumePaths: outcome.volumePaths });
      expect(fixture.calls.filter((call) => call.args[0] === 'vol-resize')).toHaveLength(2);
      expect(fixture.calls.filter((call) => call.args[0] === 'vol-upload')).toHaveLength(3);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
  it('defines the persisted UUID and reconciles a lost define response', async () => {
    const fixture = libvirtFixture();
    fixture.faults.set('define', 'after');
    const receipts: string[][] = [];
    const outcome = await createLibvirtProvider(config, fixture.exec).create({ ...spec, checkpoint: async (receipt) => { receipts.push([...receipt.volumePaths]); } });
    expect(outcome.ok).toBe(true);
    expect(fixture.domains.get(spec.domainUuid)?.name).toBe('alpha');
    expect(receipts).toEqual([[volume]]);
    expect(fixture.calls.find((call) => call.args[0] === 'define')?.stdin).toContain(`<uuid>${spec.domainUuid}</uuid>`);
    expect(fixture.volumes.has(volume)).toBe(true);
    expect(fixture.calls.some((call) => call.args[0] === 'vol-delete')).toBe(false);
  });
  it('never adopts another user domain with the same name', async () => {
    const fixture = libvirtFixture();
    fixture.domains.set('aaaa0000-0000-0000-0000-0000000000aa', { name: 'alpha', state: 'running' });
    await expect(createLibvirtProvider(config, fixture.exec).create(spec)).rejects.toThrow(/different domain/);
    expect(fixture.calls.map((call) => call.args[0])).toEqual(['list']);
  });
  it('never deletes a pre-existing or uncertain allocation on create failure', async () => {
    const fixture = libvirtFixture();
    fixture.volumes.add(volume);
    const outcome = await createLibvirtProvider(config, fixture.exec).create(spec);
    expect(outcome.ok).toBe(false);
    expect(fixture.volumes.has(volume)).toBe(true);
    expect(fixture.calls.some((call) => ['vol-create-as', 'vol-delete', 'define'].includes(call.args[0]!))).toBe(false);
  });
  it('a transport failure is not a missing domain', async () => {
    const fixture = libvirtFixture();
    fixture.faults.set('list', 'before');
    expect((await createLibvirtProvider(config, fixture.exec).create(spec)).ok).toBe(false);
    expect(fixture.volumes.size).toBe(0);
  });
  it('resumes a confirmed volume without reallocation after failed define', async () => {
    const fixture = libvirtFixture();
    fixture.faults.set('define', 'before');
    const provider = createLibvirtProvider(config, fixture.exec);
    const first = await provider.create(spec);
    expect(first.ok).toBe(false);
    expect(first.volumePaths).toEqual([volume]);
    fixture.faults.delete('define');
    expect((await provider.create({ ...spec, volumePaths: first.volumePaths })).ok).toBe(true);
    expect(fixture.calls.filter((call) => call.args[0] === 'vol-create-as')).toHaveLength(1);
  });
  it('retries disk deletion after undefine without touching foreign volumes', async () => {
    const fixture = libvirtFixture();
    const provider = createLibvirtProvider(config, fixture.exec);
    await provider.create(spec);
    fixture.volumes.add('user.qcow2');
    fixture.faults.set('vol-delete', 'before');
    await expect(provider.delete(spec.domainUuid, [volume], true)).rejects.toThrow();
    expect(fixture.domains.size).toBe(0);
    fixture.faults.delete('vol-delete');
    await provider.delete(spec.domainUuid, [volume], true);
    expect([...fixture.volumes]).toEqual(['user.qcow2']);
    await expect(provider.delete(spec.domainUuid, ['user.qcow2'], true)).rejects.toThrow(/allocation identity/);
  });
  it('graceful shutdown and default deletion retain the allocated disk', async () => {
    const fixture = libvirtFixture();
    const provider = createLibvirtProvider(config, fixture.exec);
    await provider.create(spec);
    await provider.start(spec.domainUuid);
    await provider.shutdown(spec.domainUuid);
    expect(await provider.domainState(spec.domainUuid)).toBe('shutoff');
    await provider.delete(spec.domainUuid, [volume], false);
    expect(fixture.volumes.has(volume)).toBe(true);
  });
});
