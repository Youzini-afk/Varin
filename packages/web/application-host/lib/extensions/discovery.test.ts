import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginDiscoveryService } from './discovery.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const catalog = (specifier = '@example/weather', description = 'Weather') => ({ schemaVersion: 1, entries: [{
  id: 'dev.example.weather', displayName: 'Weather', description, icon: '../assets/weather.svg',
  repository: 'https://github.com/example/weather', source: { kind: 'npm', specifier, display: specifier },
}] });
async function fixture(fetch: typeof globalThis.fetch) {
  const dataDir = await mkdtemp(join(tmpdir(), 'varin-plugin-discovery-')); roots.push(dataDir);
  const service = new PluginDiscoveryService({ dataDir, hostId: 'host-a', fetch });
  await service.setSources([{ url: 'https://catalog.example/catalog/v1.json', enabled: true }]);
  return { dataDir, service };
}

describe('Plugin discovery owner', () => {
  it('reads only explicitly configured catalogs and persists the last valid directory across failure and restart', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(catalog(), { headers: { etag: 'catalog-one' } }))
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } }));
    const { dataDir, service } = await fixture(fetch);
    expect((await service.snapshot()).sources[0]?.status).toBe('unloaded');
    expect(fetch).not.toHaveBeenCalled();
    const fresh = await service.refresh();
    expect(fresh.entries[0]?.entry.icon).toBe('https://catalog.example/assets/weather.svg');
    const stale = await service.refresh();
    expect(stale.entries).toEqual(fresh.entries);
    expect(stale.sources[0]).toMatchObject({ status: 'stale', error: 'Catalog request failed (429); retry after 60' });
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).get('If-None-Match')).toBe('catalog-one');
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['https://catalog.example/catalog/v1.json', 'https://catalog.example/catalog/v1.json']);
    const reopened = new PluginDiscoveryService({ dataDir, hostId: 'host-a', fetch });
    expect(await reopened.snapshot()).toEqual(stale);
  });

  it('coalesces concurrent refreshes and does not resurrect a removed catalog after its response', async () => {
    let complete!: (value: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(resolve => { complete = resolve; }));
    const { service } = await fixture(fetch);
    const first = service.refresh(); const second = service.refresh();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await service.setSources([]);
    complete(Response.json(catalog()));
    expect((await first).entries).toEqual([]);
    expect((await second).sources).toEqual([]);
  });

  it('keeps distinct same-ID publishers separate and combines only matching sources', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async url => Response.json(catalog(String(url).includes('different') ? '@other/weather' : '@example/weather')));
    const { service } = await fixture(fetch);
    await service.setSources(['one', 'mirror', 'different'].map(name => ({ url: `https://${name}.example/catalog/v1.json`, enabled: true })));
    const snapshot = await service.refresh();
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries.map(entry => entry.catalogs.length)).toEqual([2, 1]);
    expect(new Set(snapshot.entries.map(entry => entry.key)).size).toBe(2);
  });

  it('rejects foreign icon origins and malformed replacements without clearing a valid catalog', async () => {
    const foreign = catalog(); foreign.entries[0]!.icon = 'https://author.example/icon.svg';
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(catalog()))
      .mockResolvedValueOnce(Response.json(foreign))
      .mockResolvedValueOnce(Response.json({ schemaVersion: 999, entries: [] }));
    const { service } = await fixture(fetch);
    const original = await service.refresh();
    expect((await service.refresh()).entries).toEqual(original.entries);
    const malformed = await service.refresh();
    expect(malformed.entries).toEqual(original.entries);
    expect(malformed.sources[0]?.status).toBe('stale');
  });

  it('honors Not Modified and preserves malformed local state rather than overwriting it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(catalog(), { headers: { etag: 'one' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const { service, dataDir } = await fixture(fetch);
    const original = await service.refresh();
    const unchanged = await service.refresh();
    expect(unchanged.entries).toEqual(original.entries);
    expect(unchanged.sources[0]?.updatedAt).toBe(original.sources[0]?.updatedAt);
    const file = join(dataDir, 'extensions', 'discovery.json');
    const newer = '{"schemaVersion":99,"sources":[],"catalogs":{}}';
    await writeFile(file, newer);
    await expect(service.setSources([])).rejects.toThrow('Unsupported or malformed');
    expect(await readFile(file, 'utf8')).toBe(newer);
  });

  it('rejects malformed release selectors before replacing the persistent last-good catalog', async () => {
    const invalid = { schemaVersion: 1, entries: [{ ...catalog().entries[0],
      source: { kind: 'github-release', specifier: 'not-a-repository', display: 'Invalid release' },
    }] };
    const local = { schemaVersion: 1, entries: [{ ...catalog().entries[0],
      source: { kind: 'local', specifier: '/private/project', display: 'Publisher plugin' },
    }] };
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json(catalog()))
      .mockResolvedValueOnce(Response.json(invalid))
      .mockResolvedValueOnce(Response.json(local));
    const { service, dataDir } = await fixture(fetch);
    const original = await service.refresh();
    const rejected = await service.refresh();
    expect(rejected.entries).toEqual(original.entries);
    expect(rejected.sources[0]?.status).toBe('stale');
    expect((await service.refresh()).entries).toEqual(original.entries);
    const reopened = new PluginDiscoveryService({ dataDir, hostId: 'host-a', fetch });
    expect((await reopened.snapshot()).entries).toEqual(original.entries);
  });
});
