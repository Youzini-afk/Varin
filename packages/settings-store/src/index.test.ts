import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
  it('reuses document text across sync/async instances while verifying file signatures', async () => {
    const { filePath, store } = await createStore();
    await store.replace({ nested: { value: 1 } });
    let reads = 0, stats = 0;
    const options = { filePath,
      fsModule: { ...fs, readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => { reads++; return fs.readFileSync(...args); }) as typeof fs.readFileSync,
        statSync: ((...args: Parameters<typeof fs.statSync>) => { stats++; return fs.statSync(...args); }) as typeof fs.statSync },
      fsPromises: { ...fsPromises, readFile: ((...args: Parameters<typeof fsPromises.readFile>) => { reads++; return fsPromises.readFile(...args); }) as typeof fsPromises.readFile,
        stat: ((...args: Parameters<typeof fsPromises.stat>) => { stats++; return fsPromises.stat(...args); }) as typeof fsPromises.stat } };
    const first = createSettingsFileStore(options), second = createSettingsFileStore(options);
    await first.read(); reads = 0; stats = 0;
    for (let index = 0; index < 30; index++) {
      const value = await first.read(); (value.nested as { value: number }).value = 99;
      assert.deepEqual(second.readSync(), { nested: { value: 1 } });
    }
    assert.equal(reads, 0); assert.equal(stats, 120);
  });

  it('invalidates on another writer atomic replacement and reads fresh under a mutation lock', async () => {
    const { filePath, store } = await createStore();
    await store.replace({ before: true }); await store.read();
    await fsPromises.writeFile(`${filePath}.external`, '{"external":1}');
    await fsPromises.rename(`${filePath}.external`, filePath);
    assert.deepEqual(await store.read(), { external: 1 });
    fs.writeFileSync(filePath, '{"external":2}');
    await store.update(document => ({ ...document, local: 3 }));
    assert.deepEqual(await store.read(), { external: 2, local: 3 });
  });

  it('observes external writes without directory watching', async () => {
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


it('does not reuse a missing-file cache when its directory is created', async () => {
  const { filePath } = await createStore();
  const nested = path.join(path.dirname(filePath), 'new-directory', 'settings.json');
  const store = createSettingsFileStore({ filePath: nested });
  assert.deepEqual(await store.read(), {});
  await fsPromises.mkdir(path.dirname(nested));
  await fsPromises.writeFile(nested, '{"created":true}');
  assert.deepEqual(await store.read(), { created: true });
});


it('detects same-turn writes, corruption, replacement and removal without watch delivery', async () => {
  const { filePath } = await createStore();
  let watches = 0;
  const store = createSettingsFileStore({ filePath, fsModule: { ...fs,
    watch: (() => { watches++; throw new Error('Watch notifications unavailable'); }) as typeof fs.watch,
  } });
  assert.deepEqual(store.readSync(), {});
  fs.writeFileSync(filePath, '{"value":1}');
  assert.deepEqual(store.readSync(), { value: 1 });
  fs.writeFileSync(filePath, '{broken');
  assert.throws(() => store.readSync(), SyntaxError);
  await assert.rejects(store.read(), SyntaxError);
  fs.writeFileSync(`${filePath}.external`, '{"value":2}');
  fs.renameSync(`${filePath}.external`, filePath);
  assert.deepEqual(await store.read(), { value: 2 });
  fs.unlinkSync(filePath);
  fs.writeFileSync(`${filePath}.previous`, '{"recovered":true}');
  assert.deepEqual(store.readSync(), { recovered: true });
  fs.unlinkSync(`${filePath}.previous`);
  assert.deepEqual(await store.read(), {});
  assert.equal(watches, 0, 'signature validation must not retain redundant filesystem watchers');
});

it('releases all process resources after reads and directory removal', async () => {
  const { filePath } = await createStore();
  const source = new URL('./index.ts', import.meta.url).href;
  const script = `
    import fs from 'node:fs/promises';
    import { createSettingsFileStore } from ${JSON.stringify(source)};
    const filePath = ${JSON.stringify(filePath)};
    const store = createSettingsFileStore({ filePath });
    await store.read();
    await store.replace({ saved: true });
    store.readSync();
    await fs.rm(${JSON.stringify(path.dirname(filePath))}, { recursive: true, force: true });
    console.log('finished');
  `;
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script], { timeout: 10_000 });
  assert.equal(stdout.trim(), 'finished');
});
