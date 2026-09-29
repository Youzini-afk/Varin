import { describe, expect, it } from 'vitest';
import { createLibvirtProvider } from './libvirt-provider.js';
import { libvirtFixture } from './libvirt.test-helper.js';

const config = { id: 'hv1', kind: 'libvirt' as const, uri: 'qemu:///system' };
const spec = { name: 'alpha', memoryMiB: 2048, vcpus: 2, diskGiB: 20, domainUuid: '9f8e7d6c-1111-2222-3333-444455556666' };
const volume = `varin-${spec.domainUuid}.qcow2`;

describe('libvirt creation authority', () => {
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
