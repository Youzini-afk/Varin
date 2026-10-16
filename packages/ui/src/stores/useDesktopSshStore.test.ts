import { expect, it, vi } from 'vitest';
import type { DesktopSshInstanceStatus } from '@varin/application-client';
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
