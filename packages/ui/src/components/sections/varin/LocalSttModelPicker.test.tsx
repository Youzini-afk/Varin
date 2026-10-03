import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalSttModelPicker } from './LocalSttModelPicker';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@varin/application-client', async importOriginal => ({
  ...await importOriginal<typeof import('@varin/application-client')>(),
  runtimeFetch: api.fetch, getRuntimeKey: () => 'test-runtime', subscribeRuntimeEndpointChanged: () => () => {},
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ locale: 'en', t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
  <button onClick={onClick} disabled={disabled}>{children}</button> }));
vi.mock('@/components/ui/radio', () => ({ Radio: () => null }));
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; vi.unstubAllGlobals(); api.fetch.mockReset();
});
const model = { id: 'server-added-model', name: 'Host supplied speech model', languages: ['zh', 'ja'],
  supportsLanguageSelection: true, downloadBytes: 10_000_000, sourceUrl: 'https://example.test/model',
  installed: false, downloading: false, downloadProgress: null, downloadError: null };
function setup() {
  const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', window.document);
  vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(window.document.getElementById('app')!);
  return window.document;
}

describe('Host speech model catalog', () => {
  it('loads the Host catalog under StrictMode and selects a model supplied by the Host', async () => {
    const pending: Array<(response: Response) => void> = [];
    api.fetch.mockImplementation(() => new Promise<Response>(resolve => pending.push(resolve)));
    const document = setup();
    const onSelect = vi.fn();
    const onInfo = vi.fn();
    await act(async () => root!.render(<React.StrictMode><LocalSttModelPicker selectedModelId={model.id}
      onSelect={onSelect} onSelectionInfo={onInfo} /></React.StrictMode>));
    await act(async () => {
      for (const resolve of pending) resolve(Response.json({ models: [model] }));
    });
    expect(document.body.textContent).toContain(model.name);
    expect(onInfo).toHaveBeenLastCalledWith(model);
    const row = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes(model.name))!;
    await act(async () => row.click());
    expect(onSelect).toHaveBeenCalledWith(model.id);
  });

  it('offers a working retry after status failure instead of leaving an empty list', async () => {
    api.fetch.mockResolvedValueOnce(new Response('', { status: 500 })).mockResolvedValueOnce(Response.json({ models: [model] }));
    const document = setup();
    await act(async () => root!.render(<LocalSttModelPicker selectedModelId={model.id} onSelect={() => {}} onSelectionInfo={() => {}} />));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('HTTP 500');
    await act(async () => document.querySelector<HTMLButtonElement>('button')!.click());
    expect(document.body.textContent).toContain(model.name);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});
