import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createSettingsFileStore } from './index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsPromises.rm(root, { force: true, recursive: true })));
});

const createStore = async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'varin-settings-store-'));
  roots.push(root);
  const filePath = path.join(root, 'settings.json');
  return { filePath, store: createSettingsFileStore({ filePath }) };
};

describe('settings file store', () => {
  it('distinguishes a missing file from malformed persisted state', async () => {
    const { filePath, store } = await createStore();
    assert.deepEqual(await store.read(), {});
    assert.deepEqual(store.readSync(), {});

    await fsPromises.writeFile(filePath, '{"broken":', 'utf8');
    await assert.rejects(store.read(), SyntaxError);
    assert.throws(() => store.readSync(), SyntaxError);
  });

  it('returns a cloned caller default only when no complete document exists', async () => {
    const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'varin-settings-store-default-'));
    roots.push(root);
    const filePath = path.join(root, 'state.json');
    const defaultValue = { version: 1, entries: {} };
    const store = createSettingsFileStore({ filePath, defaultValue });

    const first = await store.read();
    (first.entries as Record<string, unknown>).changed = true;
    assert.deepEqual(await store.read(), defaultValue);

    await fsPromises.writeFile(filePath, '{}', 'utf8');
    assert.deepEqual(await store.read(), {});
  });

  it('serializes updates from independent store instances without losing fields', async () => {
    const { filePath, store } = await createStore();
    const second = createSettingsFileStore({ filePath });

    await Promise.all([
      store.update(async (current) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ...current, alpha: 1 };
      }),
      second.update((current) => ({ ...current, beta: 2 })),
    ]);

    assert.deepEqual(await store.read(), { alpha: 1, beta: 2 });
    assert.equal(fs.existsSync(`${filePath}.lock`), false);
  });

  it('reads the last complete document when replacement was interrupted', async () => {
    const { filePath, store } = await createStore();
    await fsPromises.writeFile(`${filePath}.previous`, '{"preserved":true}', 'utf8');

    assert.deepEqual(await store.read(), { preserved: true });
    assert.deepEqual(store.readSync(), { preserved: true });
  });

  it('recovers the mutation queue after a rejected update', async () => {
    const { store } = await createStore();
    await assert.rejects(store.update(() => {
      throw new Error('rejected mutation');
    }), /rejected mutation/);

    await store.update((current) => ({ ...current, recovered: true }));
    assert.deepEqual(await store.read(), { recovered: true });
  });

  it('returns a transaction result without rewriting a read-only document', async () => {
    const { filePath, store } = await createStore();
    await store.replace({ value: 1 });
    const before = await fsPromises.stat(filePath);

    const result = await store.transact((current) => ({
      result: current.value,
      write: false,
    }));

    const after = await fsPromises.stat(filePath);
    assert.equal(result, 1);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.deepEqual(await store.read(), { value: 1 });
  });

  it('writes private directory and file modes', { skip: process.platform === 'win32' }, async () => {
    const { filePath, store } = await createStore();
    await store.replace({ value: true });

    assert.equal((await fsPromises.stat(path.dirname(filePath))).mode & 0o777, 0o700);
    assert.equal((await fsPromises.stat(filePath)).mode & 0o777, 0o600);
  });

  it('preserves existing directory and file permissions', { skip: process.platform === 'win32' }, async () => {
    const { filePath, store } = await createStore();
    await fsPromises.chmod(path.dirname(filePath), 0o750);
    await fsPromises.writeFile(filePath, '{}', { mode: 0o660 });
    await fsPromises.chmod(filePath, 0o660);

    await store.replace({ saved: true });

    assert.equal((await fsPromises.stat(path.dirname(filePath))).mode & 0o777, 0o750);
    assert.equal((await fsPromises.stat(filePath)).mode & 0o777, 0o660);
  });
});

describe('shared settings read cache', () => {
  it('serves independent parsed objects across sync/async instances without file I/O', async () => {
    const { filePath, store } = await createStore();
    await store.replace({ nested: { value: 1 } });
    await new Promise(resolve => setTimeout(resolve, 10)); // Drain the atomic rename watch event.
    let reads = 0, stats = 0;
    const options = { filePath,
      fsModule: { ...fs, readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => { reads++; return fs.readFileSync(...args); }) as typeof fs.readFileSync },
      fsPromises: { ...fsPromises, readFile: ((...args: Parameters<typeof fsPromises.readFile>) => { reads++; return fsPromises.readFile(...args); }) as typeof fsPromises.readFile,
        stat: ((...args: Parameters<typeof fsPromises.stat>) => { stats++; return fsPromises.stat(...args); }) as typeof fsPromises.stat } };
    const first = createSettingsFileStore(options), second = createSettingsFileStore(options);
    await first.read(); reads = 0;
    for (let index = 0; index < 30; index++) {
      const value = await first.read(); (value.nested as { value: number }).value = 99;
      assert.deepEqual(second.readSync(), { nested: { value: 1 } });
    }
    assert.equal(reads, 0); assert.equal(stats, 0);
  });

  it('invalidates on another writer atomic replacement and reads fresh under a mutation lock', async () => {
    const { filePath, store } = await createStore();
    await store.replace({ before: true }); await store.read();
    const changed = new Promise<void>(resolve => {
      const watcher = fs.watch(path.dirname(filePath), (_event, filename) => {
        if (String(filename) === path.basename(filePath)) { watcher.close(); resolve(); }
      });
    });
    await fsPromises.writeFile(`${filePath}.external`, '{"external":1}');
    await fsPromises.rename(`${filePath}.external`, filePath);
    await changed;
    assert.deepEqual(await store.read(), { external: 1 });
    fs.writeFileSync(filePath, '{"external":2}');
    await store.update(document => ({ ...document, local: 3 }));
    assert.deepEqual(await store.read(), { external: 2, local: 3 });
  });

  it('falls back to file signatures when directory watching is unavailable', async () => {
    const { filePath } = await createStore();
    await fsPromises.writeFile(filePath, '{"v":1}');
    const store = createSettingsFileStore({ filePath, fsModule: { readFileSync: fs.readFileSync, statSync: fs.statSync,
      watch: (() => { throw new Error('Unsupported watch'); }) as typeof fs.watch } });
    assert.deepEqual(await store.read(), { v: 1 });
    await fsPromises.writeFile(filePath, '{"v":22}');
    assert.deepEqual(store.readSync(), { v: 22 });
    await fsPromises.writeFile(filePath, '{"v":333}');
    assert.deepEqual(await store.read(), { v: 333 });
  });
});


it('does not reuse a missing-file cache when a directory first becomes watchable', async () => {
  const { filePath } = await createStore();
  const nested = path.join(path.dirname(filePath), 'new-directory', 'settings.json');
  const store = createSettingsFileStore({ filePath: nested });
  assert.deepEqual(await store.read(), {});
  await fsPromises.mkdir(path.dirname(nested));
  await fsPromises.writeFile(nested, '{"created":true}');
  assert.deepEqual(await store.read(), { created: true });
});
