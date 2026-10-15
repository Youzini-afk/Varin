import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createServiceCredentialStore } from './store.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const fixture = async () => { const root = await mkdtemp(join(tmpdir(), 'varin-service-auth-')); roots.push(root); return { root, store: createServiceCredentialStore(root), path: join(root, 'service-auth.json') }; };
it('reads absent credentials without creating files and serializes independent service updates', async () => {
  const f = await fixture(); expect(f.store.read()).toEqual({}); expect(await readdir(f.root)).toEqual([]);
  await Promise.all([f.store.save('search', { key: 'fixture-search' }), f.store.save('proxy', { key: 'fixture-proxy' })]);
  expect(Object.keys(f.store.read()).sort()).toEqual(['proxy', 'search']);
  expect(await f.store.remove('search')).toBe(true); expect(await f.store.remove('search')).toBe(false);
  expect(f.store.read()).toEqual({ proxy: { type: 'api_key', key: 'fixture-proxy' } });
});
it('rejects malformed current store without overwriting it even on writes', async () => {
  const f = await fixture(), original = '{"broken":{"type":"unsupported","key":"fixture"}}';
  await writeFile(f.path, original); expect(() => f.store.read()).toThrow('invalid');
  await expect(f.store.save('search', { key: 'fixture' })).rejects.toThrow('invalid');
  await expect(f.store.remove('broken')).rejects.toThrow('invalid');
  expect(await readFile(f.path, 'utf8')).toBe(original);
});
