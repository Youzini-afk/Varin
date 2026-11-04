import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { loadMonoFont, loadUiFont } from './fontLoader';
import { CODE_FONT_OPTION_MAP, UI_FONT_OPTION_MAP, type MonoFontOption, type UiFontOption } from './fontOptions';

afterEach(() => vi.unstubAllGlobals());

it('allows every font requested by the real loader under the packaged desktop font policy', async () => {
  const sources: string[] = [], loaded = vi.fn();
  vi.stubGlobal('document', { fonts: { add: vi.fn(), delete: vi.fn() } });
  vi.stubGlobal('FontFace', class {
    constructor(_family: string, source: string) { sources.push(source); }
    load() { loaded(); return Promise.resolve(this); }
  });
  await Promise.all([
    ...Object.keys(UI_FONT_OPTION_MAP).map(font => loadUiFont(font as UiFontOption)),
    ...Object.keys(CODE_FONT_OPTION_MAP).map(font => loadMonoFont(font as MonoFontOption)),
  ]);
  expect(sources.length).toBeGreaterThan(0);
  expect(loaded).toHaveBeenCalledTimes(sources.length);
  const config = JSON.parse(readFileSync(new URL('../../../tauri/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const csp = config.app.security.csp as string;
  const fontSources = csp.split(';').map(value => value.trim().split(/\s+/)).find(([name]) => name === 'font-src')!.slice(1);
  for (const source of sources) {
    const url = new URL(/^url\(([^)]+)\)/.exec(source)![1]);
    expect(fontSources).toContain(url.origin);
  }
  // Font support must not relax the workbench's executable content policy.
  const scriptSources = csp.split(';').map(value => value.trim().split(/\s+/)).find(([name]) => name === 'script-src')!.slice(1);
  expect(scriptSources).not.toContain("'unsafe-inline'");
  expect(scriptSources).not.toContain('https:');
  expect(fontSources).not.toContain('https:');
});
