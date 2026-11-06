import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { fileSecretStore, HostCredentialService, type AccountCredential, type SecretStore } from './service.js';

function fixture() {
  const records = new Map<string, string>();
  const store: SecretStore = {
    read: async reference => records.get(reference) ?? null,
    modify: async (reference, change) => {
      const next = change(records.get(reference) ?? null);
      if (next === null) records.delete(reference); else records.set(reference, next);
    },
  };
  return new HostCredentialService('host', store);
}
const oauth = { kind: 'oauth' as const, provider: 'plugin-service', accessToken: 'old', expiresAt: 0, accountId: 'account' };

test('scoped Host capture pins API-key identity and compare-and-swap rejects stale reconnect and disconnect', async () => {
  const service = fixture();
  await service.replace({ kind: 'api-key', key: 'first' }, 'connection', undefined);
  const identity = await service.identity('connection');
  const binding = await service.captureValue('connection');
  expect((await binding.resolve()).value).toEqual({ kind: 'api-key', key: 'first' });
  await service.replace({ kind: 'api-key', key: 'second' }, 'connection', identity);
  await expect(binding.resolve()).rejects.toMatchObject({ code: 'credential-scope-changed' });
  await expect(service.replace(oauth, 'connection', identity)).rejects.toMatchObject({ code: 'credential-scope-changed' });
  await expect(service.removeIfCurrent('connection', identity)).rejects.toMatchObject({ code: 'credential-scope-changed' });
  expect((await service.resolveValue('connection')).value).toEqual({ kind: 'api-key', key: 'second' });
  binding.release();
  await expect(binding.resolve()).rejects.toMatchObject({ code: 'credential-binding-released' });
  await service.removeIfCurrent('connection', await service.identity('connection'));
  expect(await service.identity('connection')).toBeUndefined();
});

test('pinned unregistered provider refresh is shared, survives one canceled waiter, and retains identity', async () => {
  const service = fixture();
  await service.replace(oauth, 'connection', undefined);
  let finish!: (value: typeof oauth) => void;
  const refresh = vi.fn(() => new Promise<typeof oauth>(resolve => { finish = resolve; }));
  const release = vi.fn();
  const provider = { refresh, capture: () => ({ provider: { refresh }, release }) };
  const binding = await service.captureValue('connection', provider);
  const before = await service.read('connection');
  const controller = new AbortController();
  const first = binding.resolve(controller.signal);
  const second = binding.resolve();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  controller.abort();
  await expect(first).rejects.toBeDefined();
  finish({ ...oauth, accessToken: 'renewed', expiresAt: Date.now() + 60000 });
  expect(await second).toMatchObject({ account: before.account, generation: before.generation, value: { accessToken: 'renewed' } });
  binding.release(); binding.release();
  expect(release).toHaveBeenCalledOnce();
});

test('a refresh cannot overwrite a replaced or removed scoped connection', async () => {
  for (const remove of [false, true]) {
    const service = fixture();
    await service.replace(oauth, 'connection', undefined);
    let finish!: (value: AccountCredential['value'] & { kind: 'oauth' }) => void;
    const refresh = vi.fn(() => new Promise<Extract<AccountCredential['value'], { kind: 'oauth' }>>(resolve => { finish = resolve; }));
    const captured = await service.captureValue('connection', { refresh });
    const pending = captured.resolve();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const identity = await service.identity('connection');
    if (remove) await service.removeIfCurrent('connection', identity);
    else await service.replace({ kind: 'api-key', key: 'replacement' }, 'connection', identity);
    finish({ ...oauth, accessToken: 'stale', expiresAt: Date.now() + 60000 });
    await expect(pending).rejects.toMatchObject({ code: 'credential-scope-changed' });
    if (remove) expect(await service.identity('connection')).toBeUndefined();
    else expect((await service.resolveValue('connection')).value).toEqual({ kind: 'api-key', key: 'replacement' });
    captured.release();
  }
});

test('malformed existing storage and malformed refresh output never overwrite the authoritative record', async () => {
  const service = fixture();
  await service.store.modify('broken', () => '{}');
  await expect(service.replace(oauth, 'broken', undefined)).rejects.toMatchObject({ code: 'credential-invalid' });
  await expect(service.removeIfCurrent('broken', undefined)).rejects.toMatchObject({ code: 'credential-invalid' });
  expect(await service.store.read('broken')).toBe('{}');
  await service.replace(oauth, 'connection', undefined);
  const binding = await service.captureValue('connection', { refresh: async value => ({ ...value, accessToken: '' }) });
  await expect(binding.resolve()).rejects.toMatchObject({ code: 'credential-invalid' });
  expect((await service.read('connection')).value).toEqual(oauth);
  binding.release();
});


test('file namespace removal preserves other plugins, model credentials, and unrelated settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-credentials-'));
  try {
    const store = fileSecretStore(join(directory, 'credentials.json'));
    const service = new HostCredentialService('host', store);
    await service.put('first', 'plugin:one:user-a');
    await service.put('second', 'plugin:one:user-b');
    await service.put('other', 'plugin:two:user-a');
    await service.put('model', 'model-key');
    await store.modify('settings', () => JSON.stringify({ display: 'retained' }));
    await service.removePrefix('plugin:one:');
    expect(await service.identity('plugin:one:user-a')).toBeUndefined();
    expect(await service.identity('plugin:one:user-b')).toBeUndefined();
    expect((await service.resolveValue('plugin:two:user-a')).value).toEqual({ kind: 'api-key', key: 'other' });
    expect((await service.resolveValue('model-key')).value).toEqual({ kind: 'api-key', key: 'model' });
    expect(await store.read('settings')).toBe(JSON.stringify({ display: 'retained' }));
    expect(() => service.removePrefix('')).toThrow();
    await service.removePrefix('plugin:one:');
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('authorization canceled while queued cannot publish, but cancellation after commit does not roll back', async () => {
  let current: string | null = null;
  let apply!: () => void;
  const store: SecretStore = {
    read: async () => current,
    modify: async (_reference, change) => new Promise<void>((resolve, reject) => {
      apply = () => { try { current = change(current); resolve(); } catch (error) { reject(error); } };
    }),
  };
  const service = new HostCredentialService('host', store);
  const cancelled = new AbortController();
  const queued = service.replace(oauth, 'connection', undefined, () => cancelled.signal.throwIfAborted());
  cancelled.abort(); apply();
  await expect(queued).rejects.toBeDefined();
  expect(await service.identity('connection')).toBeUndefined();
  const committed = new AbortController();
  const accepted = service.replace(oauth, 'connection', undefined, () => committed.signal.throwIfAborted());
  apply(); committed.abort();
  await accepted;
  expect((await service.read('connection')).value).toEqual(oauth);
});
