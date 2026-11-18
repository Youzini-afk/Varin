import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { servePackagedUi } from './packaged-ui.js';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-ui-')); await fs.writeFile(path.join(root, 'index.html'), '<main>shared app</main>'); });
afterEach(() => fs.rm(root, { recursive: true, force: true }));
const read = (name: string, options?: RequestInit) => servePackagedUi(new Request(`varin-ui://app/${name}`, options), root,
  async url => new Response(await fs.readFile(new URL(url), 'utf8')), async () => null);

it('serves immutable shared assets, not dynamically templated window credentials', async () => {
  expect(await (await read('index.html')).text()).toBe('<main>shared app</main>');
  expect(await (await read('threads/one', { headers: { Accept: 'text/html' } })).text()).toBe('<main>shared app</main>');
  await fs.writeFile(path.join(root, 'entry.js'), 'export const ready = true;');
  expect(await (await read('entry.js')).text()).toContain('export const ready');
});
it('does not impersonate a Host, including when navigation asks for a document', async () => {
  for (const url of ['auth/session', 'api/config/settings', 'health']) {
    expect((await read(url, { headers: { Accept: 'text/html' } })).status).toBe(404);
  }
  expect((await read('api/config/settings', { method: 'POST' })).status).toBe(405);
  expect((await read('assets/missing.js')).status).toBe(404);
});
