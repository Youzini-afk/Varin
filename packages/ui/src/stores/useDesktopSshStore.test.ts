import { expect, it, vi } from 'vitest';
import type { DesktopSshInstance, DesktopSshInstancesConfig, DesktopSshInstanceStatus } from '@varin/application-client';
vi.mock('@/lib/desktop', () => ({ hasDesktopInvoke: () => true }));
vi.mock('@/lib/desktopSsh', () => ({ createDesktopSshInstance: (id: string, sshCommand: string) => ({ id, sshCommand }),
  desktopSshInstancesGet: vi.fn(), desktopSshInstancesSet: vi.fn(), desktopSshStatus: vi.fn(), desktopSshImportHosts: vi.fn(), desktopSshConnect: vi.fn(), desktopSshDisconnect: vi.fn(), listenDesktopSshStatus: vi.fn() }));
import { createSshConnectionsStore, type SshConnectionsTransport } from './useDesktopSshStore';

function fixture(id: string) {
  let receive!: (status: DesktopSshInstanceStatus) => void;
  const stop = vi.fn(async () => {});
  const transport: SshConnectionsTransport = { get: vi.fn(async () => ({ instances: [] })), set: vi.fn(async () => {}), imports: vi.fn(async () => []), status: vi.fn(async () => [{ id, phase: 'ready', startedByUs: false, retryAttempt: 0, requiresUserAction: false, updatedAtMs: 1 } as DesktopSshInstanceStatus]),
    connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), listen: vi.fn(async listener => { receive = listener; return stop; }) };
  return { transport, stop, receive: (status: DesktopSshInstanceStatus) => receive(status) };
}
it('keeps client and Agent SSH projections separate and releases only observation', async () => {
  const a = fixture('client'), b = fixture('agent');
  const client = createSshConnectionsStore(a.transport), agent = createSshConnectionsStore(b.transport);
  await Promise.all([client.getState().load(), agent.getState().load()]);
  expect(Object.keys(client.getState().statusesById)).toEqual(['client']);
  expect(Object.keys(agent.getState().statusesById)).toEqual(['agent']);
  agent.release();
  b.receive({ id: 'late', phase: 'ready' } as DesktopSshInstanceStatus);
  expect(agent.getState().statusesById).toEqual({});
  expect(client.getState().statusesById.client).toBeDefined();
  expect(b.stop).toHaveBeenCalledOnce();
  expect(b.transport.disconnect).not.toHaveBeenCalled();
  client.release();
});
it('ignores an in-flight load after the resource view is released', async () => {
  const f = fixture('agent'); let finish!: (value: { instances: [] }) => void;
  f.transport.get = () => new Promise(resolve => { finish = resolve; });
  const store = createSshConnectionsStore(f.transport);
  const loading = store.getState().load();
  store.release(); finish({ instances: [] }); await loading;
  expect(store.getState().initialized).toBe(false);
  expect(f.transport.listen).not.toHaveBeenCalled();
});

it('refuses collection writes and disconnects before a successful owner load', async () => {
  const f = fixture('agent');
  const store = createSshConnectionsStore(f.transport);
  const added = { id: 'added', sshCommand: 'ssh added' } as DesktopSshInstance;
  const assertBlocked = async () => {
    await expect(store.getState().setInstances([added])).rejects.toThrow(/Load this Host/);
    await expect(store.getState().upsertInstance(added)).rejects.toThrow(/Load this Host/);
    await expect(store.getState().createFromCommand('added', 'ssh added')).rejects.toThrow(/Load this Host/);
    await expect(store.getState().removeInstance('existing')).rejects.toThrow(/Load this Host/);
    expect(f.transport.set).not.toHaveBeenCalled();
    expect(f.transport.disconnect).not.toHaveBeenCalled();
  };
  await assertBlocked();

  let reject!: (error: Error) => void;
  f.transport.get = vi.fn(() => new Promise<DesktopSshInstancesConfig>((_resolve, fail) => { reject = fail; }));
  const loading = store.getState().load();
  await assertBlocked();
  reject(new Error('Host unavailable'));
  await loading;
  expect(store.getState().isLoading).toBe(false);
  expect(store.getState().initialized).toBe(false);
  await assertBlocked();

  const existing = { id: 'existing', sshCommand: 'ssh existing' } as DesktopSshInstance;
  f.transport.get = vi.fn(async () => ({ instances: [existing] }));
  await store.getState().load();
  await store.getState().upsertInstance(added);
  expect(f.transport.set).toHaveBeenCalledExactlyOnceWith({ instances: [added, existing] });
  expect(store.getState().instances).toEqual([added, existing]);
  store.release();
});

it('blocks writes during reload and concurrent collection saves without disconnecting', async () => {
  const f = fixture('agent');
  const store = createSshConnectionsStore(f.transport);
  await store.getState().load();
  let finish!: (config: DesktopSshInstancesConfig) => void;
  f.transport.get = vi.fn(() => new Promise<DesktopSshInstancesConfig>(resolve => { finish = resolve; }));
  const loading = store.getState().load();
  await expect(store.getState().setInstances([])).rejects.toThrow(/Load this Host/);
  await expect(store.getState().removeInstance('agent')).rejects.toThrow(/Load this Host/);
  expect(f.transport.set).not.toHaveBeenCalled();
  expect(f.transport.disconnect).not.toHaveBeenCalled();
  finish({ instances: [] });
  await loading;

  let saved!: () => void;
  f.transport.set = vi.fn(() => new Promise<void>(resolve => { saved = resolve; }));
  const saving = store.getState().createFromCommand('first', 'ssh first');
  await expect(store.getState().createFromCommand('second', 'ssh second')).rejects.toThrow(/already being saved/);
  await expect(store.getState().removeInstance('agent')).rejects.toThrow(/already being saved/);
  await store.getState().load();
  expect(f.transport.get).toHaveBeenCalledOnce();
  expect(f.transport.set).toHaveBeenCalledOnce();
  expect(f.transport.disconnect).not.toHaveBeenCalled();
  saved();
  await saving;
  expect(store.getState().instances.map(instance => instance.id)).toEqual(['first']);

  f.transport.get = vi.fn(async () => { throw new Error('Reload failed'); });
  await store.getState().load();
  expect(store.getState().instances.map(instance => instance.id)).toEqual(['first']);
  expect(store.getState().initialized).toBe(false);
  await expect(store.getState().removeInstance('first')).rejects.toThrow(/Load this Host/);
  expect(f.transport.disconnect).not.toHaveBeenCalled();
  store.release();
});
