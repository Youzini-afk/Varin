import { afterEach, expect, test, vi } from 'vitest';
import { DOMParser } from 'linkedom';
import { prepareUiFiles } from './modules';

afterEach(() => vi.unstubAllGlobals());

test('chat HTML resolves local module imports, reexports and dynamic imports without rewriting ordinary text', async () => {
  vi.stubGlobal('DOMParser', DOMParser);
  const prepared = await prepareUiFiles({
    'index.html': '<html><body><script type="module">import "./src/main.mjs"; import("./src/main.mjs");</script></body></html>',
    'src/main.mjs': 'export { value } from "../value.mjs"; const load = () => import("../value.mjs"); const label = "../value.mjs"; // import("../value.mjs")',
    'value.mjs': 'export const value = 42;',
  }, 'index.html');
  expect(prepared['index.html']).toContain('import "ui-file:/src/main.mjs"');
  expect(prepared['index.html']).toContain('import("ui-file:/src/main.mjs")');
  expect(prepared['src/main.mjs']).toContain('from "ui-file:/value.mjs"');
  expect(prepared['src/main.mjs']).toContain('import("ui-file:/value.mjs")');
  expect(prepared['src/main.mjs']).toContain('const label = "../value.mjs"; // import("../value.mjs")');
});

test('external and unresolved module references retain their original resolution', async () => {
  vi.stubGlobal('DOMParser', DOMParser);
  const code = 'import "https://example.invalid/module.js"; import "./missing.js";';
  const prepared = await prepareUiFiles({ 'index.html': '<html><body></body></html>', 'main.js': code }, 'index.html');
  expect(prepared['main.js']).toBe(code);
});

test('loads platform controls from bundled work bytes on demand and preserves authored files', async () => {
  vi.stubGlobal('DOMParser', DOMParser);
  const plain = await prepareUiFiles({ 'index.html': '<p>Plain text</p>' }, 'index.html');
  expect(Object.keys(plain)).toEqual(['index.html']);
  const prepared = await prepareUiFiles({ 'index.html': '<html><body><script type="module">import { controls } from "@varin/ui"; controls.install();</script></body></html>', '__varin_controls__.mjs': 'export const custom = true;' }, 'index.html');
  expect(prepared['__varin_controls__.mjs']).toBe('export const custom = true;');
  expect(prepared['index.html']).toContain('ui-file:/___varin_controls__.mjs');
  expect(prepared['___varin_controls__.mjs']).toContain('export const controls');
  expect(prepared['___varin_controls__.mjs']).not.toMatch(/https?:/);
});
