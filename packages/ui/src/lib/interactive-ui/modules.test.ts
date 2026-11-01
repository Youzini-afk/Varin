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
