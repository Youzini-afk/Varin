import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import { mergeHarnessSettings } from '@varin/protocol';

const fixture = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), fetch: vi.fn(), t: (key: string) => key }));
vi.mock('@varin/application-client', async importOriginal => ({
  ...await importOriginal<object>(), createEmbeddingRequestsHttpAPI: () => fixture, runtimeFetch: fixture.fetch,
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: fixture.t }) }));
vi.mock('./ConfigurationModels', () => ({ useConfigurationModels: () => ({ providers: [], modelsFor: () => [] }) }));
vi.mock('@/components/ui/input', () => ({ Input: ({ onChange, ...props }: React.InputHTMLAttributes<HTMLInputElement>) =>
  <input {...props} onInput={event => onChange?.(event as unknown as React.ChangeEvent<HTMLInputElement>)} /> }));
const { EmbeddingSettings } = await import('./EmbeddingSettings');
const { InferenceSettings } = await import('./RetrievalSettings');
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; vi.unstubAllGlobals(); vi.resetAllMocks(); });

it('preserves a failed request-settings draft and saves against the last acknowledged revision', async () => {
  const { window, document } = parseHTML('<html><body><div id="app"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('Event', window.Event); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const config = { concurrentRequests: 1, requestIntervalMs: 0 };
  fixture.read.mockResolvedValue({ config, activeConfig: config, revision: 'original', restartRequired: false });
  fixture.save.mockRejectedValueOnce(new Error('changed elsewhere'));
  const container = document.getElementById('app')!;
  root = createRoot(container);
  await act(async () => root!.render(<EmbeddingSettings harness={mergeHarnessSettings({}, {})} update={vi.fn()} />));
  const input = container.querySelector<HTMLInputElement>('input')!;
  const type = async (value: string) => act(async () => { input.value = value; input.dispatchEvent(new window.Event('input', { bubbles: true })); });
  const click = async (label: string) => act(async () => {
    const button = [...container.querySelectorAll('button')].find(item => item.textContent === label);
    expect(button).toBeTruthy(); button!.click();
  });
  await type('4');
  await click('settings.kit.save');
  expect(fixture.save).toHaveBeenCalledWith({ concurrentRequests: 4, requestIntervalMs: 0, localCpuMode: 'auto', localCpuThreads: null }, 'original');
  expect(input.value).toBe('4'); expect(container.textContent).toContain('changed elsewhere');
  await click('settings.kit.discard'); expect(input.value).toBe('1');
  fixture.save.mockResolvedValue({ config: { ...config, concurrentRequests: 2 }, activeConfig: config, revision: 'saved', restartRequired: true });
  await type('2'); await click('settings.kit.save');
  expect(container.textContent).toContain('settings.page.harness.embeddings.requests.restartRequired');
  expect(container.textContent).not.toContain('assistant.unsaved');
});

it('offers the Host model download from the local embedding selection only', async () => {
  const { window, document } = parseHTML('<html><body><div id="app"></div></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.getElementById('app')!;
  root = createRoot(container);
  const props = { harness: mergeHarnessSettings({}, {}), update: vi.fn() };
  fixture.fetch.mockResolvedValueOnce(Response.json({ status: 'not-installed' }))
    .mockResolvedValueOnce(Response.json({ status: 'installing' }, { status: 202 }))
    .mockResolvedValueOnce(Response.json({ status: 'ready', version: '1.0' }));

  await act(async () => root!.render(<><InferenceSettings {...props} kind="embedding" /><InferenceSettings {...props} kind="rerank" /></>));
  const embedding = container.querySelector('[data-settings-item="harness.embedding"]')!;
  const rerank = container.querySelector('[data-settings-item="harness.rerank"]')!;
  const local = (section: Element) => [...section.querySelectorAll('button')].find(button => button.textContent === 'settings.page.harness.localSemantic.source');
  expect(local(rerank)).toBeUndefined();
  await act(async () => local(embedding)!.click());
  expect(props.update).toHaveBeenCalledWith({ embedding: expect.objectContaining({ protocol: 'local' }) });
  const download = [...embedding.querySelectorAll('button')].find(button => button.textContent === 'settings.page.harness.localSemantic.install')!;
  await act(async () => download.click());
  expect(fixture.fetch).toHaveBeenCalledWith('/api/harness/local-semantic/install', { method: 'POST' });
  expect(embedding.querySelector('[role="status"]')?.textContent).toContain('settings.page.harness.localSemantic.status.ready');
});
