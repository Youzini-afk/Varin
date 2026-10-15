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
