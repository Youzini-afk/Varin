import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { CompanionAssets, readCompanionAssetCatalog, type CompanionAssetCatalog } from './companion-assets';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fixture(suffix = '') {
  const bodies = new Map([['bundle.json', Buffer.from(`{"version":1,"test":"${suffix}"}`)], ['atlas.png', Buffer.from(`art-${suffix}`)]]);
  const files = [...bodies].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));
  return { bodies, catalog: { schemaVersion: 1, packs: [{ id: 'varin', name: 'Varin', version: hash(JSON.stringify(files)),
    bytes: files.reduce((sum, file) => sum + file.bytes, 0), baseUrl: 'https://example.test/assets/', files }] } satisfies CompanionAssetCatalog };
}
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-companion-assets-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const fileResponse = (bodies: Map<string, Buffer>, url: string) => {
  const bytes = bodies.get(path.posix.basename(new URL(url).pathname))!;
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.subarray(0, 2)); controller.enqueue(bytes.subarray(2)); controller.close();
  } }));
};

test('downloads verified artwork once, resolves only its own files, reopens offline and reclaims it', async () => {
  const data = fixture(), fetch = vi.fn(async (url: string) => fileResponse(data.bodies, url));
  const options = { root, catalog: data.catalog, fetch, changed: vi.fn() };
  const assets = new CompanionAssets(options); await assets.initialize();
  expect(fetch).not.toHaveBeenCalled(); expect(assets.get('varin')).toBeUndefined();
  assets.start('varin'); assets.start('varin'); await assets.wait('varin');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(assets.list()[0]).toMatchObject({ installedVersion: data.catalog.packs[0]!.version, download: null });
  const prefix = `varin/${data.catalog.packs[0]!.version}/`;
  const file = await assets.resolve(`${prefix}atlas.png`);
  expect(await fs.readFile(file!)).toEqual(data.bodies.get('atlas.png'));
  expect(await assets.resolve(`${prefix}../installed.json`)).toBeNull();
  expect(await assets.resolve(`${prefix}installed.json`)).toBeNull();
  expect(await assets.resolve('varin/wrong/atlas.png')).toBeNull();
  const offline = new CompanionAssets({ ...options, fetch: async () => { throw new Error('offline'); } });
  await offline.initialize(); expect(offline.get('varin')?.version).toBe(data.catalog.packs[0]!.version);
  await offline.remove('varin'); expect(offline.list()[0]!.installedVersion).toBeNull();
  expect(await fs.readdir(path.join(root, 'packs'))).toEqual([]);
});

test('cancellation releases the reader and a restart resumes previously verified files', async () => {
  const data = fixture(); let requested!: () => void;
  const ready = new Promise<void>(resolve => { requested = resolve; });
  const cancelled = vi.fn();
  const assets = new CompanionAssets({ root, catalog: data.catalog, changed: () => {}, fetch: async url => {
    if (url.endsWith('atlas.png')) return new Response(new ReadableStream({ start() { requested(); }, cancel: cancelled }));
    return fileResponse(data.bodies, url);
  } });
  await assets.initialize(); assets.start('varin'); await ready; await assets.cancel('varin');
  expect(cancelled).toHaveBeenCalledOnce(); expect(assets.get('varin')).toBeUndefined();
  expect(assets.list()[0]!.download?.state).toBe('cancelled');
  const fetch = vi.fn(async (url: string) => fileResponse(data.bodies, url));
  const restored = new CompanionAssets({ root, catalog: data.catalog, fetch, changed: () => {} });
  await restored.initialize(); expect(restored.list()[0]!.download?.state).toBe('cancelled');
  restored.start('varin'); await restored.wait('varin');
  expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]![0]).toMatch(/atlas.png$/u);
  expect(restored.get('varin')).toBeDefined();
});

test('failed integrity keeps the old appearance; a valid update replaces it and removes retired files', async () => {
  const initial = fixture('first');
  const original = new CompanionAssets({ root, catalog: initial.catalog, fetch: async url => fileResponse(initial.bodies, url), changed: () => {} });
  await original.initialize(); original.start('varin'); await original.wait('varin');
  const next = fixture('next'); let corrupt = true;
  const beforeReplace = vi.fn(), afterReplace = vi.fn();
  const updated = new CompanionAssets({ root, catalog: next.catalog, changed: () => {}, beforeReplace, afterReplace,
    fetch: async url => corrupt && url.endsWith('atlas.png') ? new Response(Buffer.from('bad-xxxx')) : fileResponse(next.bodies, url),
  });
  await updated.initialize(); updated.start('varin'); await updated.wait('varin');
  expect(updated.get('varin')?.version).toBe(initial.catalog.packs[0]!.version);
  expect(updated.list()[0]!.download?.state).toBe('failed'); expect(beforeReplace).not.toHaveBeenCalled();
  corrupt = false; updated.start('varin'); await updated.wait('varin');
  expect(updated.get('varin')?.version).toBe(next.catalog.packs[0]!.version);
  expect(beforeReplace).toHaveBeenCalledOnce(); expect(afterReplace).toHaveBeenCalledOnce();
  expect((await fs.readdir(root)).some(name => name.startsWith('retired-'))).toBe(false);
  // A crash at the first rename must restore the previous complete appearance at next startup.
  await fs.rename(path.join(root, 'packs/varin'), path.join(root, `retired-${randomUUID()}`));
  const recovered = new CompanionAssets({ root, catalog: next.catalog, changed: () => {}, fetch: async () => { throw new Error('offline'); } });
  await recovered.initialize(); expect(recovered.get('varin')?.version).toBe(next.catalog.packs[0]!.version);
});

test('catalog identities, file boundaries and hashes cannot redirect installation outside its cache', () => {
  const data = fixture();
  for (const mutation of [
    (catalog: CompanionAssetCatalog) => { catalog.packs[0]!.id = '../outside'; },
    (catalog: CompanionAssetCatalog) => { catalog.packs[0]!.files[0]!.path = '../outside.json'; },
    (catalog: CompanionAssetCatalog) => { catalog.packs[0]!.files[0]!.sha256 = 'wrong'; },
  ]) {
    const catalog = structuredClone(data.catalog); mutation(catalog); expect(() => readCompanionAssetCatalog(catalog)).toThrow();
  }
});
